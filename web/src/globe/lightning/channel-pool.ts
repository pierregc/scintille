import { type FlashRing, NO_DELAY, type SourceDelays } from '../live';
import { CHANNEL, flashSeed, isGround } from './channel';
import { heroLot } from './density';
import { FlashPlayback } from './playback';
import { flickerLength, PROFILE } from './profile';
import { channelSkeleton, MAX_SEGMENTS, SEGMENT_FLOATS } from './skeleton';

/** Floats per drawn segment: its skeleton segment, then its flash (direction, time, intensity, radius, duration, seed). */
export const SEGMENT_STRIDE = SEGMENT_FLOATS + 8;
/** Flashes whose channels can show at once; the newest win. */
export const POOL_FLASHES = 384;
/** Channels built per frame at most, so a burst spreads over a few frames. */
export const BUILDS_PER_FRAME = 24;
/** Past this distance from its time origin, the pool starts afresh to keep float32 times precise. */
const REBASE_MS = 6 * 3_600_000;

/** Detections of two instruments this close in time (ms) and space (degrees) are one flash: it gets one channel. */
const TWIN_MS = 400;
const TWIN_DEG = 0.15;

/** Called with a range of segments, in instances, whose data changed. */
export type SegmentRangeListener = (start: number, count: number) => void;

/** Channel segments of the flashes still flickering, one fixed slot of `MAX_SEGMENTS` per flash, built once. */
export class ChannelPool {
	readonly data: Float32Array;
	/** Time origin of stored flash times, UTC ms. */
	origin = Number.NaN;
	/** Segments to draw: up to the highest slot in use. */
	count = 0;
	/** Flashes with a channel in the pool. */
	flashes = 0;
	/** Flashes of the sample still in their flicker or fade, what the pool wants a slot for; at most `capacity` are counted. */
	flickering = 0;
	readonly #slots: (string | undefined)[];
	readonly #free: number[] = [];
	readonly #byKey = new Map<string, number>();
	/** Lot of each ring slot, keyed by the flash time it was computed for. */
	readonly #lot: Float32Array;
	readonly #lotTime: Float64Array;
	#generation = -1;
	#delays: SourceDelays | null = null;

	constructor(readonly ring: FlashRing, readonly capacity = POOL_FLASHES, readonly onRange: SegmentRangeListener = () => {}) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`bad capacity ${capacity}`);
		this.data = new Float32Array(capacity * MAX_SEGMENTS * SEGMENT_STRIDE);
		this.#slots = new Array<string | undefined>(capacity);
		this.#lot = new Float32Array(ring.capacity);
		this.#lotTime = new Float64Array(ring.capacity);
		for (let s = capacity - 1; s >= 0; s--) this.#free.push(s);
	}

	/**
	 * Keeps a slot for each flash of the sample still in its flicker phase at `sceneTime`: those whose lot is
	 * under `share` (1 keeps every flash); `enabled` false empties the pool.
	 */
	sync(sceneTime: number, playback = new FlashPlayback(), delays: SourceDelays = NO_DELAY, enabled = true, share = 1): void {
		const ring = this.ring;
		if (ring.generation !== this.#generation || delays !== this.#delays || !(Math.abs(sceneTime - this.origin) < REBASE_MS)) {
			this.#generation = ring.generation;
			this.#delays = delays;
			this.#reset(sceneTime);
		}
		const wanted: number[] = [];
		if (enabled) {
			const cutoff = sceneTime - playback.span(PROFILE.maxFlicker + CHANNEL.fade, sceneTime) - delays.max;
			let lo = 0;
			let hi = ring.size;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (ring.time[ring.slot(mid)] < cutoff) lo = mid + 1;
				else hi = mid;
			}
			// Newest first, so a full pool keeps the latest channels.
			for (let i = ring.size - 1; i >= lo && wanted.length < this.capacity; i--) {
				const s = ring.slot(i);
				if (ring.time[s] > sceneTime - delays.min) continue;
				const playsAt = ring.time[s] + delays.ms[ring.source[s]];
				if (playsAt > sceneTime) continue;
				if (share < 1 && this.#lotOf(s) >= share) continue;
				if (playback.age(playsAt, sceneTime) >= flickerLength(ring.durationMs[s]) + CHANNEL.fade) continue;
				if (this.#twin(wanted, s)) continue;
				wanted.push(i);
			}
		}
		this.flickering = wanted.length;
		const keep = new Set<string>();
		for (const i of wanted) keep.add(this.#key(i));
		for (const [key, slot] of this.#byKey) {
			if (keep.has(key)) continue;
			this.#byKey.delete(key);
			this.#slots[slot] = undefined;
			this.#free.push(slot);
		}
		this.#free.sort((a, b) => b - a);
		let built = 0;
		for (const i of wanted) {
			const key = this.#key(i);
			if (this.#byKey.has(key) || built >= BUILDS_PER_FRAME) continue;
			const slot = this.#free.pop();
			if (slot === undefined) break;
			this.#write(slot, i, delays);
			this.#byKey.set(key, slot);
			this.#slots[slot] = key;
			built++;
		}
		let top = -1;
		for (let s = this.capacity - 1; s >= 0; s--) {
			if (this.#slots[s] !== undefined) {
				top = s;
				break;
			}
		}
		this.count = (top + 1) * MAX_SEGMENTS;
		this.flashes = this.#byKey.size;
	}

	#reset(sceneTime: number): void {
		this.origin = Math.round(sceneTime);
		this.#byKey.clear();
		this.#free.length = 0;
		for (let s = this.capacity - 1; s >= 0; s--) {
			this.#slots[s] = undefined;
			this.#free.push(s);
		}
		this.count = 0;
	}

	#lotOf(s: number): number {
		const ring = this.ring;
		const time = ring.time[s];
		if (this.#lotTime[s] !== time) {
			this.#lot[s] = heroLot(flashSeed(time, ring.lat[s], ring.lon[s]), ring.intensity[s]);
			this.#lotTime[s] = time;
		}
		return this.#lot[s];
	}

	/** Whether another instrument's detection of the same flash already has a channel among `wanted`, newest first. */
	#twin(wanted: number[], s: number): boolean {
		const ring = this.ring;
		for (let k = wanted.length - 1; k >= 0; k--) {
			const o = ring.slot(wanted[k]);
			if (ring.time[o] - ring.time[s] > TWIN_MS) break;
			if (ring.source[o] === ring.source[s]) continue;
			if (Math.abs(ring.lat[o] - ring.lat[s]) < TWIN_DEG && Math.abs(ring.lon[o] - ring.lon[s]) < TWIN_DEG / Math.max(0.2, Math.cos((ring.lat[s] * Math.PI) / 180))) return true;
		}
		return false;
	}

	/** Stable identity of a ring flash, whatever its place in the ring. */
	#key(i: number): string {
		const ring = this.ring;
		const s = ring.slot(i);
		return `${ring.time[s]}|${ring.lat[s]}|${ring.lon[s]}|${ring.source[s]}`;
	}

	#write(slot: number, i: number, delays: SourceDelays): void {
		const ring = this.ring;
		const s = ring.slot(i);
		const lat = (ring.lat[s] * Math.PI) / 180;
		const lon = (ring.lon[s] * Math.PI) / 180;
		const seed = flashSeed(ring.time[s], ring.lat[s], ring.lon[s]);
		const radius = Math.max(3, Math.sqrt(ring.areaKm2[s] / Math.PI));
		const skeleton = channelSkeleton(seed, radius, isGround(seed));
		const flash = [
			Math.cos(lat) * Math.cos(lon),
			Math.sin(lat),
			-Math.cos(lat) * Math.sin(lon),
			(ring.time[s] + delays.ms[ring.source[s]] - this.origin) / 1000,
			ring.intensity[s],
			radius,
			ring.durationMs[s],
			seed,
		];
		const start = slot * MAX_SEGMENTS;
		for (let k = 0; k < MAX_SEGMENTS; k++) {
			const o = (start + k) * SEGMENT_STRIDE;
			if (k < skeleton.count) this.data.set(skeleton.data.subarray(k * SEGMENT_FLOATS, (k + 1) * SEGMENT_FLOATS), o);
			// Unused segments have no width and are skipped by the shader.
			else this.data.fill(0, o, o + SEGMENT_FLOATS);
			this.data.set(flash, o + SEGMENT_FLOATS);
		}
		this.onRange(start, MAX_SEGMENTS);
	}
}
