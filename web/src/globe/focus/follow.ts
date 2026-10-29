import { Vector3 } from 'three';
import type { StormBounds } from '../../contract/types';
import type { GlobeControls } from '../controls';
import type { FlyToOptions } from '../flight';
import { ahead, frameStorm, GRAZE } from '../replay/framing';
import { latLonToVector } from '../sun';
import { floorRange } from '../surface';

export type FollowMode = 'frame' | 'horizon';

export const FOLLOW = {
	/** Rate of the critically damped glide, 1/s: a step is 96 % done after 2 s. */
	omega: 2.5,
	/** A storm further than this from the camera is reached by a flight. */
	flightDeg: 4,
	/** Half width of the framed area, in footprint radii, and its minimum in km. */
	pad: 1,
	minHalfKm: 40,
};

/** Where the followed storm was last observed. */
export interface FollowTarget {
	lat: number;
	lon: number;
	radiusKm: number | null;
}

const RAD = Math.PI / 180;
/** Below these the glide ends exactly on its goal: anchor in Earth radii (0.6 m), log range, tilt in degrees, lead in km, heading in degrees. */
const SETTLE = [1e-7, 1e-5, 1e-3, 1e-3, 1e-3];
const KM_PER_DEG = 111.2;
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Box of `halfKm` around a point, for `frameStorm`. */
export function boxAround(lat: number, lon: number, halfKm: number): StormBounds {
	const dLat = halfKm / KM_PER_DEG;
	const dLon = Math.min(halfKm / (KM_PER_DEG * Math.max(Math.cos(lat * RAD), 0.05)), 179);
	return { south: Math.max(lat - dLat, -90), north: Math.min(lat + dLat, 90), west: wrap(lon - dLon), east: wrap(lon + dLon) };
}

/**
 * Camera view keeping a storm in sight: its footprint inside the storm frame's safe area at the frame
 * tilt, or the horizon view looking along `heading` from the camera floor.
 */
export function followView(target: FollowTarget, mode: FollowMode, heading: number, fov: number, aspect: number): Required<FlyToOptions> & { leadKm: number } {
	if (mode === 'horizon') {
		const altitude = (floorRange(GRAZE.tilt * RAD, 1) * 6371) + 1;
		return { ...ahead(target, heading, GRAZE.leadKm), altitude, tilt: GRAZE.tilt, heading, duration: GRAZE.duration, leadKm: GRAZE.leadKm };
	}
	const half = Math.max((target.radiusKm ?? 0) * FOLLOW.pad, FOLLOW.minHalfKm);
	const frame = frameStorm(boxAround(target.lat, target.lon, half), fov, aspect);
	return { ...frame, lat: target.lat, lon: target.lon, heading, leadKm: 0 };
}

/** Exact step of a critically damped spring toward 0 over `dt` seconds. */
export function dampStep(x: number, v: number, omega: number, dt: number): [number, number] {
	const e = Math.exp(-omega * dt);
	const k = v + omega * x;
	return [(x + k * dt) * e, (v - omega * k * dt) * e];
}

interface Spring { x: number; v: number }

type FollowControls = Pick<GlobeControls, 'flyTo' | 'place' | 'view' | 'flying' | 'onSurface' | 'onInput'>;

/**
 * Keeps the camera on a storm's latest observed position. The camera glides toward it and never past
 * it, so it lags the observations and predicts nothing; any camera input from the visitor stops it.
 */
export class StormFollow {
	#state: 'off' | 'flying' | 'tracking' = 'off';
	#mode: FollowMode = 'frame';
	#heading = 0;
	#revision = 0;
	#target: FollowTarget | null = null;
	#desired: { key: string; view: ReturnType<typeof followView> } | null = null;
	readonly #anchor = new Vector3();
	readonly #velocity = new Vector3();
	#range: Spring = { x: 0, v: 0 };
	#tilt: Spring = { x: 0, v: 0 };
	#lead: Spring = { x: 0, v: 0 };
	#turn: Spring = { x: 0, v: 0 };
	#settled = false;
	#last: number | undefined;
	readonly #offInput: () => void;
	readonly #listeners = new Set<() => void>();

	constructor(
		readonly controls: FollowControls,
		readonly view: () => { fov: number; aspect: number },
		readonly reducedMotion: () => boolean = () => false,
	) {
		this.#offInput = controls.onInput(() => this.stop());
	}

	get active(): boolean { return this.#state !== 'off'; }
	get mode(): FollowMode { return this.#mode; }

	/** Calls `listener` whenever following starts or stops. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(target: FollowTarget | null, mode: FollowMode, heading: number): void {
		const was = this.active;
		this.#mode = mode;
		this.#heading = heading;
		this.#target = target ?? this.#target;
		this.#state = 'tracking';
		this.#last = undefined;
		this.#fromCamera();
		if (!was) this.#emit();
		if (this.#target) this.#steer(this.#target, true);
	}

	setMode(mode: FollowMode, heading: number): void {
		if (!this.active) return;
		this.#mode = mode;
		this.#heading = heading;
		this.#desired = null;
		this.#settled = false;
	}

	stop(): void {
		if (this.#state === 'off') return;
		this.#state = 'off';
		this.#revision++;
		this.#desired = null;
		this.#target = null;
		this.#emit();
	}

	dispose(): void {
		this.stop();
		this.#offInput();
		this.#listeners.clear();
	}

	/** Call once per frame; `target` is the latest observed position, or null to hold the last one. */
	update(now: number, target: FollowTarget | null): void {
		if (this.#state === 'off') return;
		if (target) this.#target = target;
		const dt = this.#last === undefined ? 0 : Math.min(Math.max((now - this.#last) / 1000, 0), 0.1);
		this.#last = now;
		if (this.#state === 'flying') return;
		if (this.controls.flying()) {
			this.stop();
			return;
		}
		if (this.#target) this.#steer(this.#target, false);
		if (this.#state !== 'tracking') return;
		this.#step(dt);
	}

	#emit(): void { for (const listener of this.#listeners) listener(); }

	#desiredView(target: FollowTarget) {
		const { fov, aspect } = this.view();
		const key = [target.lat, target.lon, target.radiusKm, this.#mode, this.#heading, fov, aspect].join();
		if (this.#desired?.key !== key) {
			this.#desired = { key, view: followView(target, this.#mode, this.#heading, fov, aspect) };
			this.#settled = false;
		}
		return this.#desired.view;
	}

	/** Flies when the storm is far from the camera or the camera is not over the ground yet. */
	#steer(target: FollowTarget, starting: boolean): void {
		const view = this.#desiredView(target);
		const anchor = new Vector3(...latLonToVector(target.lat, target.lon));
		const far = this.#anchor.angleTo(anchor) > FOLLOW.flightDeg * RAD;
		if (!far && !(starting && !this.controls.onSurface())) return;
		const revision = ++this.#revision;
		this.#state = 'flying';
		void this.controls.flyTo(view).then((arrived) => {
			if (revision !== this.#revision || this.#state !== 'flying') return;
			if (!arrived) {
				this.stop();
				return;
			}
			this.#state = 'tracking';
			this.#snapTo(this.#target ?? target);
		});
	}

	#fromCamera(): void {
		const current = this.controls.view();
		const lead = this.#mode === 'horizon' ? GRAZE.leadKm : 0;
		const anchor = ahead(current, (current.heading ?? 0) + 180, lead);
		this.#anchor.set(...latLonToVector(anchor.lat, anchor.lon));
		this.#velocity.set(0, 0, 0);
		this.#range = { x: Math.log(Math.max(current.altitude, 1)), v: 0 };
		this.#tilt = { x: current.tilt, v: 0 };
		this.#lead = { x: lead, v: 0 };
		this.#turn = { x: current.heading ?? 0, v: 0 };
		this.#settled = false;
	}

	#snapTo(target: FollowTarget): void {
		const view = this.#desiredView(target);
		this.#anchor.set(...latLonToVector(target.lat, target.lon));
		this.#velocity.set(0, 0, 0);
		this.#range = { x: Math.log(view.altitude), v: 0 };
		this.#tilt = { x: view.tilt, v: 0 };
		this.#lead = { x: view.leadKm, v: 0 };
		this.#turn = { x: view.heading, v: 0 };
		this.#settled = false;
	}

	#step(dt: number): void {
		if (!this.#target) return;
		const view = this.#desiredView(this.#target);
		if (this.#settled) return;
		const goal = new Vector3(...latLonToVector(this.#target.lat, this.#target.lon));
		const turn = view.heading + 360 * Math.round((this.#turn.x - view.heading) / 360);
		const goals = [Math.log(view.altitude), view.tilt, view.leadKm, turn];
		let snapped = this.reducedMotion();
		if (!snapped) {
			const offset = this.#anchor.clone().sub(goal);
			const next = new Vector3();
			for (const axis of ['x', 'y', 'z'] as const) {
				const [x, v] = dampStep(offset[axis], this.#velocity[axis], FOLLOW.omega, dt);
				next[axis] = x;
				this.#velocity[axis] = v;
			}
			// Never past the observed position: crossing it ends the glide there.
			if (next.dot(offset) <= 0) {
				this.#anchor.copy(goal);
				this.#velocity.set(0, 0, 0);
			} else {
				this.#anchor.copy(goal).add(next).normalize();
				this.#velocity.projectOnPlane(this.#anchor);
			}
			[this.#range, this.#tilt, this.#lead, this.#turn] = [this.#range, this.#tilt, this.#lead, this.#turn]
				.map((s, i) => spring(s, goals[i], dt));
			snapped = this.#anchor.distanceTo(goal) < SETTLE[0] && this.#velocity.length() < SETTLE[0] &&
				[this.#range, this.#tilt, this.#lead, this.#turn].every((s, i) => Math.abs(s.v) < SETTLE[i + 1] && Math.abs(s.x - goals[i]) < SETTLE[i + 1]);
		}
		if (snapped) this.#snapTo(this.#target);
		this.controls.place(this.#pose());
		this.#settled = snapped;
	}

	#pose(): FlyToOptions {
		const a = this.#anchor;
		const lat = Math.asin(Math.max(-1, Math.min(1, a.y))) / RAD;
		const lon = Math.atan2(-a.z, a.x) / RAD;
		const heading = ((this.#turn.x % 360) + 360) % 360;
		const aim = ahead({ lat, lon }, heading, this.#lead.x);
		return { lat: aim.lat, lon: aim.lon, altitude: Math.exp(this.#range.x), tilt: this.#tilt.x, heading };
	}
}

function spring(s: Spring, goal: number, dt: number): Spring {
	const [x, v] = dampStep(s.x - goal, s.v, FOLLOW.omega, dt);
	return { x: goal + x, v };
}
