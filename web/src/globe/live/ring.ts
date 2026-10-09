import { CHUNK_SCALES, type DecodedChunk } from './decode';

/** About 1.6 hours at the fixture rate of 44 flashes per second. */
export const DEFAULT_CAPACITY = 1 << 18;

/**
 * Fixed-size columnar store of flashes. When full, the oldest flashes are overwritten.
 * Slot `i` of every column describes the same flash.
 */
export class FlashRing {
	readonly capacity: number;
	/** Event time, UTC milliseconds. */
	readonly time: Float64Array;
	readonly lat: Float32Array;
	readonly lon: Float32Array;
	readonly intensity: Float32Array;
	readonly areaKm2: Float32Array;
	readonly durationMs: Float32Array;
	readonly source: Uint8Array;
	readonly quality: Uint8Array;
	#head = 0;
	#written = 0;

	constructor(capacity = DEFAULT_CAPACITY) {
		if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError(`bad capacity ${capacity}`);
		this.capacity = capacity;
		this.time = new Float64Array(capacity);
		this.lat = new Float32Array(capacity);
		this.lon = new Float32Array(capacity);
		this.intensity = new Float32Array(capacity);
		this.areaKm2 = new Float32Array(capacity);
		this.durationMs = new Float32Array(capacity);
		this.source = new Uint8Array(capacity);
		this.quality = new Uint8Array(capacity);
	}

	/** Number of valid slots. */
	get size(): number {
		return Math.min(this.#written, this.capacity);
	}

	/** Slot the next flash goes to. */
	get head(): number {
		return this.#head;
	}

	/** Flashes pushed since creation; lets a consumer find what is new since its last read. */
	get written(): number {
		return this.#written;
	}

	/** Slot of the `i`-th oldest flash still stored. */
	slot(i: number): number {
		return (this.#head - this.size + i + this.capacity) % this.capacity;
	}

	push(chunk: DecodedChunk): void {
		const { count, start, columns: c } = chunk;
		const skip = Math.max(0, count - this.capacity);
		for (let i = skip; i < count; i++) {
			const s = this.#head;
			this.time[s] = start + c.event_offset_ms[i];
			this.lat[s] = c.lat[i] * CHUNK_SCALES.lat;
			this.lon[s] = c.lon[i] * CHUNK_SCALES.lon;
			this.intensity[s] = c.intensity[i] * CHUNK_SCALES.intensity;
			this.areaKm2[s] = c.area_km2[i] * CHUNK_SCALES.area_km2;
			this.durationMs[s] = c.duration_ms[i] * CHUNK_SCALES.duration_ms;
			this.source[s] = c.source[i];
			this.quality[s] = c.quality[i];
			this.#head = (s + 1) % this.capacity;
		}
		this.#written += count;
	}
}
