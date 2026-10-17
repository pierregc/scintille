import type { ChunkRef, StormDetail } from '../../contract/types';
import { stormSource } from './storm';
import type { SceneClock } from '../clock';
import type { LiveFeed } from '../live';
import { fetchChunk, type DecodedChunk } from '../live/decode';
import { FlashRing } from '../live/ring';

export interface ArchiveSource {
	/** Scene bounds in event time, UTC milliseconds; end is inclusive. */
	start: number;
	end: number;
	load(signal: AbortSignal): Promise<DecodedChunk[]>;
}

/** Reads existing immutable SCNT gzip chunks; paths remain relative to their manifest. */
export async function loadArchiveChunks(
	manifestUrl: string,
	refs: readonly ChunkRef[],
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<DecodedChunk[]> {
	const chunks: DecodedChunk[] = [];
	const unique = new Map(refs.map((ref) => [new URL(ref.path, manifestUrl).href, ref]));
	const entries = [...unique.entries()];
	for (let i = 0; i < entries.length; i += 6) {
		signal.throwIfAborted();
		const batch = entries.slice(i, i + 6);
		const results = await Promise.allSettled(batch.map(async ([url, ref]) => {
			const chunk = await fetchChunk(url, fetchFn, signal, { stored: ref.size_bytes, decoded: 2 * 1024 * 1024 });
			if (chunk.count !== ref.flash_count) throw new Error(`archive count mismatch: ${url}`);
			return chunk;
		}));
		signal.throwIfAborted();
		for (const result of results) {
			if (result.status === 'rejected') throw result.reason;
			chunks.push(result.value);
		}
	}
	return chunks;
}

/** Owns feed transitions and a bounded renderer window over an immutable extract. */
export class SceneData {
	readonly ring: FlashRing;
	readonly #clock: SceneClock;
	readonly #startLive: (ring: FlashRing) => LiveFeed;
	readonly #offMode: () => void;
	#live: LiveFeed;
	#archive: { ring: FlashRing; start: number; end: number } | undefined;
	#windowStart = -1;
	#request: AbortController | undefined;
	#revision = 0;
	#disposed = false;
	#suspended = false;
	#returning: Promise<void> | undefined;

	constructor(clock: SceneClock, live: LiveFeed, startLive: (ring: FlashRing) => LiveFeed) {
		this.#clock = clock;
		this.#live = live;
		this.ring = live.ring;
		this.#startLive = startLive;
		this.#offMode = clock.on('mode', (mode) => {
			if (mode === 'live') void this.live();
		});
	}

	get liveClient(): LiveFeed['client'] {
		return this.#live.client;
	}

	covers(time: number): boolean {
		return this.#archive
			? time >= this.#archive.start && time <= this.#archive.end
			: this.#live.client.covers(time);
	}

	coverageStart(): number | null {
		return this.#archive?.start ?? this.#live.client.coverageStart();
	}

	/** A newer open, return to live or dispose cancels this request without publishing stale data. */
	open(source: ArchiveSource, speed = 1): Promise<boolean> {
		return this.#open(async () => source, speed);
	}

	async openStorm(baseUrl: string, slug: string, speed = 1, fetchFn: typeof fetch = fetch): Promise<StormDetail | null> {
		let detail: StormDetail | undefined;
		const opened = await this.#open(async (signal) => {
			const storm = await stormSource(baseUrl, slug, signal, fetchFn);
			detail = storm.detail;
			return storm.source;
		}, speed);
		return opened ? detail ?? null : null;
	}

	async #open(resolve: (signal: AbortSignal) => Promise<ArchiveSource>, speed: number): Promise<boolean> {
		if (this.#disposed) throw new Error('scene data is disposed');
		if (!(Number.isFinite(speed) && speed > 0)) throw new RangeError('invalid replay speed');
		const revision = ++this.#revision;
		this.#request?.abort();
		const request = new AbortController();
		this.#request = request;
		try {
			const source = await resolve(request.signal);
			if (revision !== this.#revision) return false;
			if (!Number.isFinite(source.start) || !Number.isFinite(source.end) || source.end < source.start) {
				throw new RangeError('invalid archive bounds');
			}
			const chunks = await source.load(request.signal);
			if (revision !== this.#revision) return false;
			const count = chunks.reduce((total, chunk) => total + chunk.count, 0);
			const archive = new FlashRing(Math.max(count, 1));
			for (const chunk of chunks) archive.push(chunk);
			await this.#returning;
			if (revision !== this.#revision) return false;
			this.#suspended = true;
			this.#live.stop();
			await this.#live.client.idle();
			if (revision !== this.#revision) return false;
			this.#archive = { ring: archive, start: source.start, end: source.end };
			this.#windowStart = -1;
			this.update(source.start);
			this.#clock.replay(source.start, speed);
			return true;
		} catch (error) {
			if (request.signal.aborted) return false;
			throw error;
		} finally {
			if (this.#request === request) this.#request = undefined;
		}
	}

	/** Moves the bounded ring window on seeks and as playback crosses its middle. */
	update(time: number): void {
		const archive = this.#archive?.ring;
		if (!archive) return;
		let lo = 0;
		let hi = archive.size;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (archive.time[archive.slot(mid)] < time) lo = mid + 1;
			else hi = mid;
		}
		const count = Math.min(archive.size, this.ring.capacity);
		const quarter = Math.max(1, Math.floor(count / 4));
		if (this.#windowStart >= 0 &&
			(lo >= this.#windowStart + quarter || this.#windowStart === 0) &&
			(lo < this.#windowStart + count - quarter || this.#windowStart + count === archive.size)) return;
		const from = Math.max(0, Math.min(lo - Math.floor(count / 2), archive.size - count));
		if (from === this.#windowStart) return;
		if (this.#windowStart < 0) this.ring.replace(archive, from, count);
		else this.ring.slide(archive, from, count);
		this.#windowStart = from;
	}

	live(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#revision++;
		this.#request?.abort();
		this.#request = undefined;
		if (this.#returning) return this.#returning;
		if (!this.#archive && !this.#suspended) {
			if (this.#clock.mode !== 'live') this.#clock.live();
			return Promise.resolve();
		}
		this.#archive = undefined;
		this.ring.clear();
		this.#live.stop();
		this.#returning = this.#live.client.idle().then(() => {
			if (!this.#disposed) {
				this.#live = this.#startLive(this.ring);
				this.#suspended = false;
			}
		}).finally(() => { this.#returning = undefined; });
		if (this.#clock.mode !== 'live') this.#clock.live();
		return this.#returning;
	}

	dispose(): void {
		this.#disposed = true;
		this.#revision++;
		this.#request?.abort();
		this.#request = undefined;
		this.#archive = undefined;
		this.#offMode();
		this.#live.stop();
		this.ring.clear();
	}
}
