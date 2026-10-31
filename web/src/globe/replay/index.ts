import type { StormDetail } from '../../contract/types';
import type { SceneData } from '../archive';
import type { SceneClock } from '../clock';
import type { GlobeControls } from '../controls';
import type { FlyToOptions } from '../flight';
import { frameStorm, grazeStorm } from './framing';
import type { ReplayLocation } from './url';
import { sameFrame } from './checkpoint';
import { ReplayExpiredError, REPLAY_RETENTION_DAYS, replayStart } from '../archive/storm';

type Origin = 'user' | 'navigation';

/** Wall time the replay keeps playing past the storm's last flash before the globe goes back to live, ms. */
export const END_GRACE_MS = 10_000;

export interface ReplayState {
	selected: StormDetail | null;
	loading: string | null;
	error: string | null;
}

/** Production entry shared by discovery and URL restoration; SceneData owns all data transitions. */
export class StormReplay {
	#state: ReplayState = { selected: null, loading: null, error: null };
	#revision = 0;
	#disposed = false;
	readonly #offMode: () => void;
	readonly #listeners = new Set<(origin: Origin) => void>();
	#graze: { pose: Required<FlyToOptions>; flying: boolean } | null = null;
	#endedSince: number | null = null;

	constructor(
		readonly data: Pick<SceneData, 'openStorm' | 'live'>,
		readonly clock: SceneClock,
		readonly controls: Pick<GlobeControls, 'flyTo' | 'cancelFlight' | 'isAt'>,
		readonly baseUrl: string,
		readonly view: () => { fov: number; aspect: number },
	) {
		this.#offMode = clock.on('mode', (mode) => {
			if (mode === 'live' && this.#clear()) this.#emit('user');
		});
	}

	get state(): Readonly<ReplayState> { return this.#state; }

	onChange(listener: (origin: Origin) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(origin: Origin): void { for (const listener of this.#listeners) listener(origin); }

	async open(slug: string, speed = 60, restore?: ReplayLocation, origin: Origin = 'user', checkpoint?: ReplayLocation['view']): Promise<boolean> {
		if (this.#disposed) return false;
		const revision = ++this.#revision;
		this.controls.cancelFlight();
		this.#graze = null;
		this.#state = { ...this.#state, loading: slug, error: null };
		try {
			const detail = await this.data.openStorm(this.baseUrl, slug, speed);
			if (!detail || revision !== this.#revision) return false;
			this.#state = { selected: detail, loading: slug, error: null };
			await this.#place(detail, revision, restore, checkpoint);
			if (revision === this.#revision) {
				this.#state = { ...this.#state, loading: null };
				this.#emit(origin);
			}
			return revision === this.#revision;
		} catch (error) {
			if (revision !== this.#revision) return false;
			const message = error instanceof ReplayExpiredError
				? `Replays are kept ${REPLAY_RETENTION_DAYS} days. Try a more recent storm or return to live.`
				: 'This storm replay could not be opened. Try another storm or return to live.';
			this.#state = { ...this.#state, loading: null, error: message };
			return false;
		}
	}

	async restore(state: ReplayLocation): Promise<void> {
		const detail = this.#state.selected;
		if (!detail || this.#disposed) return;
		const revision = ++this.#revision;
		this.controls.cancelFlight();
		this.#state = { ...this.#state, error: null };
		this.clock.setSpeed(state.speed);
		await this.#place(detail, revision, state);
	}

	async #place(detail: StormDetail, revision: number, restore?: ReplayLocation, checkpoint?: ReplayLocation['view']): Promise<void> {
		this.clock.pause();
		if (restore) {
			const start = replayStart(detail);
			this.clock.seek(Math.min(Math.max(restore.time ?? start, start), Date.parse(detail.storm.t_end)));
		}
		const { fov, aspect } = this.view();
		if (restore?.view) await this.controls.flyTo({ ...restore.view, duration: 0 }, { preserveRange: true });
		else {
			const frame = frameStorm(detail.bounds, fov, aspect);
			await this.controls.flyTo({ ...frame, duration: sameFrame(checkpoint, frame) ? 0 : frame.duration });
		}
		if (revision !== this.#revision) return;
		if (this.clock.mode === 'replay' && !restore?.paused) this.clock.play();
	}

	/** True while the camera flies to or stays at the horizon view of the open storm. */
	get grazing(): boolean {
		const graze = this.#graze;
		return Boolean(graze && this.#state.selected && (graze.flying || this.controls.isAt(graze.pose)));
	}

	/** Flies to the horizon view over the storm's current position, or back to the whole storm. */
	async graze(on: boolean): Promise<boolean> {
		const detail = this.#state.selected;
		if (!detail || this.#state.loading || this.#disposed) return false;
		const { fov, aspect } = this.view();
		const pose = on ? grazeStorm(detail, this.clock.time()) : frameStorm(detail.bounds, fov, aspect);
		const graze = on ? { pose, flying: true } : null;
		this.#graze = graze;
		const arrived = await this.controls.flyTo(pose);
		if (graze) graze.flying = false;
		return arrived;
	}

	/** Whether the open replay has played past the storm's last flash. */
	get ended(): boolean {
		const detail = this.#state.selected;
		return Boolean(detail && !this.#state.loading && this.clock.mode === 'replay' && this.clock.time() > Date.parse(detail.storm.t_end));
	}

	/** Plays the open storm again from its first flash, leaving the camera where it is. */
	restart(): void {
		const detail = this.#state.selected;
		if (!detail || this.#state.loading || this.clock.mode !== 'replay') return;
		this.clock.seek(replayStart(detail));
		this.clock.play();
	}

	/** Call once per frame: back to live, with every flash, after `END_GRACE_MS` of playing past the storm's end. */
	update(): void {
		if (!this.ended || !this.clock.playing) {
			this.#endedSince = null;
			return;
		}
		const now = this.clock.wallTime();
		this.#endedSince ??= now;
		if (now - this.#endedSince >= END_GRACE_MS) void this.live();
	}

	live(origin: Origin = 'user'): Promise<void> {
		this.#clear();
		const returning = this.data.live();
		this.#emit(origin);
		return returning;
	}

	#clear(): boolean {
		const hadState = Boolean(this.#state.selected || this.#state.loading || this.#state.error);
		this.#revision++;
		this.controls.cancelFlight();
		this.#graze = null;
		this.#endedSince = null;
		this.#state = { selected: null, loading: null, error: null };
		return hadState;
	}

	dispose(): void {
		this.#disposed = true;
		this.#clear();
		this.#offMode();
		this.#listeners.clear();
	}
}
