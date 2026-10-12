import { type FlashRing, NO_DELAY, type RingWatcher, type SourceDelays } from '../live';

/** Floats per flash: direction xyz, time (s from origin), intensity, radius (km), duration (ms). */
export const FLASH_STRIDE = 7;

/** Beyond this distance between scene time and origin, times are rebased to keep float32 precision. */
export const REBASE_MS = 6 * 3_600_000;

const MIN_RADIUS_KM = 3;
const DEG = Math.PI / 180;

/** Called with a range of instances, in flashes, whose data changed. */
export type RangeListener = (start: number, count: number) => void;

/**
 * GPU-ready copy of a ring window, filled incrementally: the newest flashes, or, when the GPU
 * holds fewer flashes than the ring, the ones from the playhead on (replay).
 * Times are when a flash plays (event time plus its source delay), in seconds relative to `origin`
 * so they fit in float32.
 */
export class FlashInstances {
	readonly capacity: number;
	readonly data: Float32Array;
	/** Origin of stored times, UTC ms. */
	origin = Number.NaN;
	#count = 0;
	#cursor = 0;
	/** Ring window on the GPU, in `ring.written` indices. */
	#start = 0;
	#end = 0;
	readonly #ring: FlashRing;
	readonly #changes: RingWatcher;
	readonly #onRange: RangeListener;
	#delays: SourceDelays = NO_DELAY;
	/** How long a flash stays visible, so the window keeps it behind the playhead. */
	lookbackMs: number;

	/** Defaults to the ring's capacity, so the whole live window stays on the GPU. */
	constructor(ring: FlashRing, capacity = ring.capacity, onRange: RangeListener = () => {}, lookbackMs = 0) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`bad capacity ${capacity}`);
		this.capacity = capacity;
		this.data = new Float32Array(capacity * FLASH_STRIDE);
		this.#ring = ring;
		this.#changes = ring.watch();
		this.#onRange = onRange;
		this.lookbackMs = lookbackMs;
	}

	/** Valid instances. */
	get count(): number {
		return this.#count;
	}

	/** Copies what the playhead needs and was not copied yet; reloads after a rebase or a seek back out of the window. */
	sync(sceneTime: number, delays = NO_DELAY): void {
		const ring = this.#ring;
		const oldest = ring.written - ring.size;
		const changed = this.#changes.from;
		this.#changes.from = Number.POSITIVE_INFINITY;
		// When the lookback holds more than fits, keep the flashes closest to the playhead.
		const need = Math.max(
			this.#firstAt(sceneTime - this.lookbackMs - delays.max),
			this.#firstAt(sceneTime - delays.min + 1) - this.capacity,
		);
		const from = Math.max(oldest, Math.min(need, ring.written - this.capacity));
		this.#start = Math.max(this.#start, oldest, this.#end - this.capacity);
		if (
			delays !== this.#delays ||
			!(Math.abs(sceneTime - this.origin) < REBASE_MS) ||
			need < this.#start ||
			changed < Math.min(this.#end, Math.max(this.#start, from))
		) {
			this.origin = Math.round(sceneTime);
			this.#delays = delays;
			this.#count = 0;
			this.#cursor = 0;
			this.#start = this.#end = from;
		} else if (changed < this.#end) {
			// A late chunk was merged into the window: copy again from where it landed.
			const back = this.#end - changed;
			this.#cursor = (this.#cursor - back + this.capacity) % this.capacity;
			this.#count -= back;
			this.#end = changed;
		} else if (this.#end < from) {
			// Skip flashes the playhead has already passed.
			this.#start = this.#end = from;
		}
		const room = this.capacity - (this.#end - Math.max(need, this.#start));
		this.#copy(Math.min(ring.written - this.#end, room));
	}

	/** Written index of the first stored flash at or after `time`. */
	#firstAt(time: number): number {
		const ring = this.#ring;
		let lo = 0;
		let hi = ring.size;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ring.time[ring.slot(mid)] < time) lo = mid + 1;
			else hi = mid;
		}
		return ring.written - ring.size + lo;
	}

	#copy(n: number): void {
		if (n <= 0) return;
		const ring = this.#ring;
		const data = this.data;
		const delays = this.#delays.ms;
		const first = this.#end - (ring.written - ring.size);
		const start = this.#cursor;
		for (let k = 0; k < n; k++) {
			const s = ring.slot(first + k);
			const lat = ring.lat[s] * DEG;
			const lon = ring.lon[s] * DEG;
			const o = this.#cursor * FLASH_STRIDE;
			const cosLat = Math.cos(lat);
			// Same convention as latLonToVector, without allocating.
			data[o] = cosLat * Math.cos(lon);
			data[o + 1] = Math.sin(lat);
			data[o + 2] = -cosLat * Math.sin(lon);
			data[o + 3] = (ring.time[s] + delays[ring.source[s]] - this.origin) / 1000;
			data[o + 4] = ring.intensity[s];
			data[o + 5] = Math.max(MIN_RADIUS_KM, Math.sqrt(ring.areaKm2[s] / Math.PI));
			data[o + 6] = ring.durationMs[s];
			this.#cursor = (this.#cursor + 1) % this.capacity;
		}
		this.#end += n;
		this.#count = Math.min(this.#count + n, this.capacity);
		const head = Math.min(n, this.capacity - start);
		this.#onRange(start, head);
		if (n > head) this.#onRange(0, n - head);
	}
}
