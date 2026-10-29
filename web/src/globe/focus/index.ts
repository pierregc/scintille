import type { ActiveCell, ActiveStorms, Source, StormDetail } from '../../contract/types';
import type { ClockMode, SceneClock } from '../clock';
import type { GlobeControls } from '../controls';
import { type FlyToOptions, worldToKm } from '../flight';
import { zoomLimits } from '../orbit';
import type { StormReplay } from '../replay';
import { bearing, frameStorm, grazeStorm } from '../replay/framing';
import type { StormTrack } from '../replay/track';
import { type ActiveFeed, type CellResolution, pickCell, resolveCell } from './active';
import { FootprintLayer } from './footprint';
import { type FollowTarget, StormFollow } from './follow';
import { type FocusSubject, liveSubject, observe, type Observation, replaySubject } from './subject';

/** A storm picked on the live globe, followed through merges and replacements. */
export interface LiveSelection {
	/** Id followed now. */
	id: string;
	/** Latest cell seen for it. */
	cell: ActiveCell;
	/** Set once the followed storm merged into the one shown, with the name it had and when. */
	merged: { name: string | null; at: number } | null;
	end: CellResolution['end'];
	/** Cells of the latest snapshot that split off it. */
	splits: ActiveCell[];
	/** published_at of the snapshot it was last resolved in. */
	publishedAt: number;
}

export interface FocusStatus {
	subject: FocusSubject | null;
	observation: Observation;
	/** Time of the newest flashes drawn for the subject's sources. */
	observed: number;
	live: LiveSelection | null;
}

export interface FocusOptions {
	clock: SceneClock;
	replay: StormReplay;
	feed: ActiveFeed | null;
	controls: GlobeControls;
	track: StormTrack;
	view: () => { fov: number; aspect: number };
	/** Observed time for a storm seen by `sources`. */
	observedTime: (sources: readonly Source[]) => number;
	reducedMotion?: () => boolean;
}

const PENDING: Observation = { state: 'pending', point: null, previous: null };
/** Below this height the camera flies back out when the visitor leaves a storm, km. */
const CLOSE_KM = 8000;

/** The storm the scene is about, in replay or live: its footprint, track, framing and following. */
export class StormFocus {
	readonly footprint = new FootprintLayer();
	readonly follow: StormFollow;
	#live: LiveSelection | null = null;
	#snapshot: ActiveStorms | null = null;
	#replayed: { detail: StormDetail; subject: FocusSubject } | null = null;
	#cell: { cell: ActiveCell; subject: FocusSubject } | null = null;
	#graze: { pose: Required<FlyToOptions>; flying: boolean } | null = null;
	#status: FocusStatus = { subject: null, observation: PENDING, observed: 0, live: null };
	#hadReplay = false;
	readonly #off: (() => void)[];

	constructor(readonly options: FocusOptions) {
		const { clock, replay, feed, controls, view } = options;
		this.follow = new StormFollow(controls, view, options.reducedMotion);
		this.#off = [
			clock.on('mode', (mode) => this.#onMode(mode)),
			replay.onChange(() => {
				this.follow.stop();
				this.#graze = null;
				const had = this.#hadReplay;
				this.#hadReplay = Boolean(replay.state.selected);
				if (had && !replay.state.selected && clock.mode === 'live') this.#flyOut();
			}),
		];
		if (clock.mode === 'live') feed?.start();
	}

	/** Whether a live storm is selected; storm views draw each flash alone (ADR 0020). */
	get selected(): boolean { return this.#live !== null; }
	get live(): LiveSelection | null { return this.#live; }
	get following(): boolean { return this.follow.active; }
	status(): Readonly<FocusStatus> { return this.#status; }

	get subject(): FocusSubject | null {
		const { replay } = this.options;
		const detail = replay.state.selected;
		if (detail && !replay.state.loading && this.options.clock.mode === 'replay') {
			if (this.#replayed?.detail !== detail) this.#replayed = { detail, subject: replaySubject(detail) };
			return this.#replayed.subject;
		}
		const cell = this.#live?.cell;
		if (!cell) return null;
		if (this.#cell?.cell !== cell) this.#cell = { cell, subject: liveSubject(cell) };
		return this.#cell.subject;
	}

	/** Cells of the live snapshot, for picking. */
	cells(): readonly ActiveCell[] {
		return this.options.clock.mode === 'live' ? (this.options.feed?.snapshot?.cells ?? []) : [];
	}

	/** Selects the live cell at (lat, lon), or the nearest within `radiusKm`; false when none. */
	pick(lat: number, lon: number, radiusKm: number): boolean {
		const cell = pickCell(this.cells(), lat, lon, radiusKm);
		if (!cell) return false;
		this.select(cell);
		return true;
	}

	select(cell: ActiveCell): void {
		const snapshot = this.options.feed?.snapshot;
		if (this.options.clock.mode !== 'live' || !snapshot) return;
		this.follow.stop();
		this.#graze = null;
		this.#snapshot = snapshot;
		this.#live = { id: cell.id, cell, merged: null, end: null, splits: splits(snapshot, cell.id), publishedAt: Date.parse(snapshot.published_at) };
		const { fov, aspect } = this.options.view();
		void this.options.controls.flyTo(frameStorm(cell.bounds, fov, aspect));
	}

	/** Leaves the storm: back to live from a replay, or drops the live selection; both fly back out. */
	globe(): void {
		const { replay } = this.options;
		if (replay.state.selected || replay.state.loading) {
			void replay.live();
			return;
		}
		if (!this.#live) return;
		this.#clearLive();
		this.#flyOut();
	}

	setFollow(on: boolean): void {
		if (!on) {
			this.follow.stop();
			return;
		}
		if (!this.subject || this.options.replay.state.loading) return;
		const horizon = this.horizon;
		const { controls } = this.options;
		const heading = controls.onSurface() ? (controls.view().heading ?? 0) : 0;
		this.#graze = null;
		this.follow.start(target(this.#status.observation), horizon ? 'horizon' : 'frame', heading);
	}

	/** Whether the camera looks toward the horizon over the storm, or follows it that way. */
	get horizon(): boolean {
		if (this.follow.active) return this.follow.mode === 'horizon';
		const subject = this.subject;
		if (subject?.kind === 'replay') return this.options.replay.grazing;
		const graze = this.#graze;
		return Boolean(subject && graze && (graze.flying || this.options.controls.isAt(graze.pose)));
	}

	async setHorizon(on: boolean): Promise<void> {
		const subject = this.subject;
		if (!subject) return;
		const { controls, replay, view } = this.options;
		const heading = controls.view().heading ?? 0;
		if (this.follow.active) {
			const { point, previous } = this.#status.observation;
			const motion = point && previous && (point.lat !== previous.lat || point.lon !== previous.lon) ? bearing(previous, point) : null;
			this.follow.setMode(on ? 'horizon' : 'frame', on ? (motion ?? heading) : heading);
			return;
		}
		if (subject.kind === 'replay') {
			await replay.graze(on);
			return;
		}
		const cell = this.#live?.cell;
		if (!cell) return;
		const { fov, aspect } = view();
		const track = cell.path.map((p) => ({ ...p, area_km2: 0 }));
		const pose = on ? grazeStorm({ track, bounds: cell.bounds }, this.#status.observed) : frameStorm(cell.bounds, fov, aspect);
		const graze = on ? { pose, flying: true } : null;
		this.#graze = graze;
		await controls.flyTo(pose);
		if (graze) graze.flying = false;
	}

	/** Call once per frame before drawing, after the controls. */
	update(now: number): void {
		const { feed, replay, track } = this.options;
		if (replay.state.loading) this.follow.stop();
		const snapshot = feed?.snapshot ?? null;
		if (this.#live && snapshot && snapshot !== this.#snapshot) this.#resolve(snapshot);
		const subject = this.subject;
		const observed = this.options.observedTime(subject?.sources ?? []);
		const observation = subject ? observe(subject, observed) : PENDING;
		this.#status = { subject, observation, observed, live: this.#live };
		this.footprint.set(subject?.footprint(observation) ?? null, subject?.level ?? 0, now);
		this.footprint.update(now);
		if (subject?.kind === 'replay') track.setStorm(replay.state.selected);
		else if (this.#live) track.setPath(this.#live.cell, this.#live.cell.path, this.#live.cell.level);
		else track.setStorm(null);
		track.setTime(observed);
		this.follow.update(now, target(observation));
	}

	#resolve(snapshot: ActiveStorms): void {
		this.#snapshot = snapshot;
		const live = this.#live;
		if (!live) return;
		const resolution = resolveCell(snapshot, live.id);
		const publishedAt = Date.parse(snapshot.published_at);
		if (resolution.cell) {
			const merged = resolution.via === 'merged' && resolution.cell.id !== live.id
				? { name: live.cell.name, at: mergeTime(snapshot, live.id) ?? publishedAt } : live.merged;
			this.#live = { id: resolution.cell.id, cell: resolution.cell, merged, end: null, splits: splits(snapshot, resolution.cell.id), publishedAt };
			return;
		}
		this.#live = { ...live, end: resolution.end, splits: [], publishedAt };
		if (resolution.end && resolution.end.reason !== 'source-gap') this.follow.stop();
	}

	#onMode(mode: ClockMode): void {
		const { feed } = this.options;
		if (mode === 'live') feed?.start();
		else feed?.stop();
		this.follow.stop();
		this.#graze = null;
		this.#clearLive();
	}

	#clearLive(): void {
		this.follow.stop();
		this.#graze = null;
		this.#live = null;
		this.#cell = null;
		this.#snapshot = null;
	}

	#flyOut(): void {
		const { controls, view } = this.options;
		const { fov, aspect } = view();
		const altitude = worldToKm(zoomLimits(1, fov, aspect).fit - 1, 1);
		const current = controls.view();
		if (!controls.onSurface() && current.altitude > CLOSE_KM) return;
		void controls.flyTo({ lat: current.lat, lon: current.lon, altitude, tilt: 0 });
	}

	dispose(): void {
		for (const off of this.#off) off();
		this.follow.dispose();
		this.options.feed?.stop();
		this.footprint.dispose();
		this.#live = null;
		this.#cell = null;
		this.#replayed = null;
	}
}

function target({ point }: Observation): FollowTarget | null {
	return point ? { lat: point.lat, lon: point.lon, radiusKm: point.radiusKm } : null;
}

function splits(snapshot: ActiveStorms, id: string): ActiveCell[] {
	return snapshot.cells.filter((cell) => cell.split_from === id);
}

/** Last flash of the storm `id`, or of a storm it became, before it merged away. */
function mergeTime(snapshot: ActiveStorms, id: string): number | null {
	const seen = new Set<string>();
	let current: string | null = id;
	while (current && !seen.has(current)) {
		seen.add(current);
		const ended = snapshot.ended.find((e) => e.id === current);
		if (!ended) return null;
		if (ended.reason === 'merged') return Date.parse(ended.t_end);
		current = ended.into;
	}
	return null;
}
