import { CHUNK_SCALES, type DecodedChunk } from './decode';

/** About 1.6 hours at the fixture rate of 44 flashes per second. */
export const DEFAULT_CAPACITY = 1 << 18;

/** Lowest `written` index whose flash changed since the watcher last reset `from`. */
export interface RingWatcher {
	from: number;
}

/**
 * Fixed-size columnar store of flashes, kept in event time order whatever the arrival order.
 * When full, the oldest flashes are overwritten. Slot `i` of every column describes the same flash.
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
	#written = 0;
	#size = 0;
	#windowSource: FlashRing | undefined;
	#generation = 0;
	readonly #watchers: RingWatcher[] = [];

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

	/** Changes when the observations are replaced, including an empty replacement. */
	get generation(): number {
		return this.#generation;
	}

	clear(): void {
		this.#written = 0;
		this.#size = 0;
		this.#windowSource = undefined;
		this.#generation++;
		for (const watcher of this.#watchers) watcher.from = 0;
	}

	/** Starts a new dataset from a bounded, ordered window of another ring. */
	replace(source: FlashRing, from: number, count: number): void {
		this.#validateWindow(source, from, count);
		this.clear();
		this.#windowSource = source;
		this.#copyWindow(source, from, count);
	}

	/** Moves through the same immutable dataset, preserving observation indices and active audio. */
	slide(source: FlashRing, from: number, count: number): void {
		this.#validateWindow(source, from, count);
		if (source !== this.#windowSource) throw new Error('window source changed');
		if (count !== this.#size) throw new Error('window size changed');
		const first = source.written - source.size + from;
		const changed = first < this.#written - this.#size ? first : this.#written;
		this.#copyWindow(source, from, count);
		for (const watcher of this.#watchers) watcher.from = Math.min(watcher.from, changed);
	}

	#validateWindow(source: FlashRing, from: number, count: number): void {
		if (source === this || !Number.isInteger(from) || !Number.isInteger(count) || from < 0 || count < 0 || from + count > source.size || count > this.capacity) {
			throw new RangeError('invalid ring window');
		}
	}

	#copyWindow(source: FlashRing, from: number, count: number): void {
		const first = source.written - source.size + from;
		for (let i = 0; i < count; i++) {
			const slot = source.slot(from + i);
			const target = (first + i) % this.capacity;
			this.time[target] = source.time[slot];
			this.lat[target] = source.lat[slot];
			this.lon[target] = source.lon[slot];
			this.intensity[target] = source.intensity[slot];
			this.areaKm2[target] = source.areaKm2[slot];
			this.durationMs[target] = source.durationMs[slot];
			this.source[target] = source.source[slot];
			this.quality[target] = source.quality[slot];
		}
		this.#written = first + count;
		this.#size = count;
	}

	/** Number of valid slots. */
	get size(): number {
		return this.#size;
	}

	/** Slot the next flash goes to. */
	get head(): number {
		return this.#written % this.capacity;
	}

	/** Logical index after the last flash; with `size`, maps `written` indices to stored flashes. */
	get written(): number {
		return this.#written;
	}

	/** Slot of the `i`-th oldest flash still stored. */
	slot(i: number): number {
		return (this.#written - this.size + i) % this.capacity;
	}

	/** Returns a watcher told where each push changed the ring, so a copy can refresh from there. */
	watch(): RingWatcher {
		const watcher = { from: Number.POSITIVE_INFINITY };
		this.#watchers.push(watcher);
		return watcher;
	}

	/** Merges the chunk in event time order; flashes later than every stored one are a plain append. */
	push(chunk: DecodedChunk): void {
		const { count, start, columns: c } = chunk;
		if (count === 0) return;
		const offsets = c.event_offset_ms;
		const order = Uint32Array.from({ length: count }, (_, i) => i);
		for (let i = 1; i < count; i++) {
			if (offsets[i] < offsets[i - 1]) {
				order.sort((a, b) => offsets[a] - offsets[b] || a - b);
				break;
			}
		}
		const end = this.#written;
		const at = this.#firstAfter(start + offsets[order[0]]);
		const tail = this.#copyOut(at, end);
		let t = 0;
		let k = 0;
		for (let w = at; w < end + count; w++) {
			const s = w % this.capacity;
			if (k < count && (t === tail.length || start + offsets[order[k]] < tail.time[t])) {
				const i = order[k++];
				this.time[s] = start + offsets[i];
				this.lat[s] = c.lat[i] * CHUNK_SCALES.lat;
				this.lon[s] = c.lon[i] * CHUNK_SCALES.lon;
				this.intensity[s] = c.intensity[i] * CHUNK_SCALES.intensity;
				this.areaKm2[s] = c.area_km2[i] * CHUNK_SCALES.area_km2;
				this.durationMs[s] = c.duration_ms[i] * CHUNK_SCALES.duration_ms;
				this.source[s] = c.source[i];
				this.quality[s] = c.quality[i];
			} else {
				this.time[s] = tail.time[t];
				this.lat[s] = tail.lat[t];
				this.lon[s] = tail.lon[t];
				this.intensity[s] = tail.intensity[t];
				this.areaKm2[s] = tail.areaKm2[t];
				this.durationMs[s] = tail.durationMs[t];
				this.source[s] = tail.source[t];
				this.quality[s] = tail.quality[t];
				t++;
			}
		}
		this.#written += count;
		this.#size = Math.min(this.#size + count, this.capacity);
		this.#windowSource = undefined;
		for (const watcher of this.#watchers) watcher.from = Math.min(watcher.from, at);
	}

	/** Written index of the first stored flash strictly after `time`. */
	#firstAfter(time: number): number {
		let lo = 0;
		let hi = this.size;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.time[this.slot(mid)] <= time) lo = mid + 1;
			else hi = mid;
		}
		return this.#written - this.size + lo;
	}

	/** Copies stored flashes [from, to), in `written` indices, out of the ring. */
	#copyOut(from: number, to: number) {
		const n = to - from;
		const out = {
			length: n,
			time: new Float64Array(n),
			lat: new Float32Array(n),
			lon: new Float32Array(n),
			intensity: new Float32Array(n),
			areaKm2: new Float32Array(n),
			durationMs: new Float32Array(n),
			source: new Uint8Array(n),
			quality: new Uint8Array(n),
		};
		for (let j = 0; j < n; j++) {
			const s = (from + j) % this.capacity;
			out.time[j] = this.time[s];
			out.lat[j] = this.lat[s];
			out.lon[j] = this.lon[s];
			out.intensity[j] = this.intensity[s];
			out.areaKm2[j] = this.areaKm2[s];
			out.durationMs[j] = this.durationMs[s];
			out.source[j] = this.source[s];
			out.quality[j] = this.quality[s];
		}
		return out;
	}
}
