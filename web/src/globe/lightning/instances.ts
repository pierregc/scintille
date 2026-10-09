import type { FlashRing } from '../live';

/** Floats per flash: direction xyz, time (s from origin), intensity, radius (km). */
export const FLASH_STRIDE = 6;

export const DEFAULT_LIGHTNING_CAPACITY = 1 << 17;

/** Beyond this distance between scene time and origin, times are rebased to keep float32 precision. */
export const REBASE_MS = 6 * 3_600_000;

const MIN_RADIUS_KM = 3;
const DEG = Math.PI / 180;

/** Called with a range of instances, in flashes, whose data changed. */
export type RangeListener = (start: number, count: number) => void;

/**
 * GPU-ready copy of the newest flashes of a ring, filled incrementally.
 * Times are stored in seconds relative to `origin` so they fit in float32.
 */
export class FlashInstances {
	readonly capacity: number;
	readonly data: Float32Array;
	/** Origin of stored times, UTC ms. */
	origin = Number.NaN;
	#count = 0;
	#cursor = 0;
	#read = 0;
	readonly #ring: FlashRing;
	readonly #onRange: RangeListener;

	constructor(ring: FlashRing, capacity = DEFAULT_LIGHTNING_CAPACITY, onRange: RangeListener = () => {}) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`bad capacity ${capacity}`);
		this.capacity = capacity;
		this.data = new Float32Array(capacity * FLASH_STRIDE);
		this.#ring = ring;
		this.#onRange = onRange;
	}

	/** Valid instances. */
	get count(): number {
		return this.#count;
	}

	/** Copies the flashes pushed since the last call; rebases first if `sceneTime` is far from the origin. */
	sync(sceneTime: number): void {
		const ring = this.#ring;
		if (!(Math.abs(sceneTime - this.origin) < REBASE_MS)) {
			this.origin = Math.round(sceneTime);
			this.#count = 0;
			this.#cursor = 0;
			this.#copy(Math.min(ring.size, this.capacity));
			return;
		}
		const fresh = ring.written - this.#read;
		if (fresh > 0) this.#copy(Math.min(fresh, ring.size, this.capacity));
	}

	#copy(n: number): void {
		const ring = this.#ring;
		const data = this.data;
		const first = ring.size - n;
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
			data[o + 3] = (ring.time[s] - this.origin) / 1000;
			data[o + 4] = ring.intensity[s];
			data[o + 5] = Math.max(MIN_RADIUS_KM, Math.sqrt(ring.areaKm2[s] / Math.PI));
			this.#cursor = (this.#cursor + 1) % this.capacity;
		}
		this.#read = ring.written;
		this.#count = Math.min(this.#count + n, this.capacity);
		if (n === 0) return;
		const head = Math.min(n, this.capacity - start);
		this.#onRange(start, head);
		if (n > head) this.#onRange(0, n - head);
	}
}
