import type { ChunkRef, LiveManifest } from '../../contract/types';
import { CONTRACT_MAJOR, ChunkFormatError, fetchChunk, type DecodedChunk } from './decode';
import { LIVE_DELAYS } from './delay';
import type { FlashRing } from './ring';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Chunks ending this close to the newest one load first: they hold what live mode plays now. */
export const DEFAULT_RECENT_MS = LIVE_DELAYS.max + 60_000;

/** The zone allows 300 requests per 10 s per address: older chunks wait while the page is above this. */
export const DEFAULT_OLDER_BUDGET = 120;
export const DEFAULT_OLDER_SPACING_MS = 50;
/** Older chunks reach the ring in batches, newest first, so coverage grows back without a gap. */
export const OLDER_BATCH = 30;
const OLDER_CONCURRENCY = 6;
const PRESSURE_WAIT_MS = 250;

export interface Backoff {
	initialMs: number;
	maxMs: number;
}

type Download = { chunk: DecodedChunk } | { error: unknown };

export const DEFAULT_BACKOFF: Backoff = { initialMs: 5_000, maxMs: 300_000 };

/** Delay before retry number `failures` (1-based): exponential, capped, with jitter in [d/2, d]. */
export function backoffDelay(failures: number, { initialMs, maxMs }: Backoff, random: () => number): number {
	const d = Math.min(maxMs, initialMs * 2 ** Math.max(0, failures - 1));
	return d / 2 + random() * (d / 2);
}

export interface Visibility {
	hidden(): boolean;
	/** Calls `listener` on every change; returns the unsubscribe function. */
	subscribe(listener: () => void): () => void;
}

export const documentVisibility: Visibility = {
	hidden: () => document.hidden,
	subscribe(listener) {
		document.addEventListener('visibilitychange', listener);
		return () => document.removeEventListener('visibilitychange', listener);
	},
};

export interface LiveClientOptions {
	/** Root of the feed; the manifest is at `<baseUrl>/live/manifest.json`. Must be absolute. */
	baseUrl: string;
	ring: FlashRing;
	pollIntervalMs?: number;
	backoff?: Backoff;
	/** Chunks downloaded in parallel. */
	concurrency?: number;
	recentMs?: number;
	/** Requests the page started in the last 10 s; older chunks start only below `olderBudget`. */
	pressure?: () => number;
	olderBudget?: number;
	/** Minimum gap between two older chunk requests. */
	olderSpacingMs?: number;
	fetch?: typeof fetch;
	visibility?: Visibility;
	random?: () => number;
	onManifest?: (manifest: LiveManifest) => void;
	/** Every chunk pushed into the ring, with its manifest entry. */
	onChunk?: (chunk: DecodedChunk, ref: ChunkRef) => void;
	onError?: (error: unknown) => void;
	/** Wall clock, UTC ms; when unset, the client does not record when data was loaded. */
	now?: () => number;
}

/** Polls the live manifest and pushes every chunk it has not seen yet into the ring, once. */
export class LiveClient {
	readonly manifestUrl: URL;
	readonly #ring: FlashRing;
	readonly #pollIntervalMs: number;
	readonly #backoff: Backoff;
	readonly #concurrency: number;
	readonly #recentMs: number;
	readonly #pressure: () => number;
	readonly #olderBudget: number;
	readonly #olderSpacingMs: number;
	readonly #fetch: typeof fetch;
	readonly #visibility: Visibility;
	readonly #random: () => number;
	readonly #onManifest?: (manifest: LiveManifest) => void;
	readonly #onChunk?: (chunk: DecodedChunk, ref: ChunkRef) => void;
	readonly #onError: (error: unknown) => void;
	readonly #seen = new Set<string>();
	readonly #now: () => number;
	#manifest: LiveManifest | null = null;
	#loadedAt: number | null = null;
	/** Ingest windows [start, end) of the chunks loaded into the ring, by path. */
	readonly #loaded = new Map<string, readonly [number, number]>();
	#failures = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#polling = false;
	#inFlight: Promise<void> | undefined;
	/** Older chunks still loading in the background, by path; polls go on meanwhile. */
	readonly #backfilling = new Set<string>();
	#backfill: Promise<void> | undefined;
	#nextOlderAt = 0;
	#running = false;
	#abort: AbortController | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(options: LiveClientOptions) {
		const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.manifestUrl = new URL('live/manifest.json', base);
		this.#ring = options.ring;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#concurrency = options.concurrency ?? 48;
		this.#recentMs = options.recentMs ?? DEFAULT_RECENT_MS;
		this.#pressure = options.pressure ?? (() => 0);
		this.#olderBudget = options.olderBudget ?? DEFAULT_OLDER_BUDGET;
		this.#olderSpacingMs = options.olderSpacingMs ?? DEFAULT_OLDER_SPACING_MS;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#visibility = options.visibility ?? documentVisibility;
		this.#random = options.random ?? Math.random;
		this.#onManifest = options.onManifest;
		this.#onChunk = options.onChunk;
		this.#onError = options.onError ?? (() => {});
		this.#now = options.now ?? (() => Number.NaN);
	}

	/** Latest manifest whose recent chunks all reached the ring, or null. */
	get manifest(): LiveManifest | null {
		return this.#manifest;
	}

	/** When that manifest was fully loaded (UTC ms), or null. */
	get loadedAt(): number | null {
		return this.#loadedAt;
	}

	/** Consecutive failed polls. */
	get failures(): number {
		return this.#failures;
	}

	/** Whether `time` (UTC ms) falls inside a chunk window loaded into the ring. */
	covers(time: number): boolean {
		for (const [start, end] of this.#loaded.values()) if (time >= start && time < end) return true;
		return false;
	}

	/** Start of the earliest loaded chunk window (UTC ms), or null. */
	coverageStart(): number | null {
		let first: number | null = null;
		for (const [start] of this.#loaded.values()) if (first === null || start < first) first = start;
		return first;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#abort = new AbortController();
		this.#unsubscribe = this.#visibility.subscribe(() => this.#onVisibilityChange());
		if (!this.#visibility.hidden()) void this.poll();
	}

	stop(): void {
		this.#running = false;
		this.#unsubscribe?.();
		this.#abort?.abort();
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Resolves once the current poll and its older chunks, if any, have finished. */
	async idle(): Promise<void> {
		await this.#inFlight;
		await this.#backfill;
	}

	/** Fetches the manifest and every missing chunk. Concurrent calls are ignored. */
	poll(): Promise<void> {
		if (this.#polling || !this.#running) return Promise.resolve();
		this.#inFlight = this.#poll();
		return this.#inFlight;
	}

	async #poll(): Promise<void> {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#polling = true;
		const signal = this.#abort?.signal;
		try {
			const manifest = await this.#fetchManifest(signal);
			this.#onManifest?.(manifest);
			await this.#fetchMissing(manifest, signal, () => {
				this.#manifest = manifest;
				const at = this.#now();
				this.#loadedAt = Number.isNaN(at) ? null : at;
			});
			if (!this.#running) return;
			this.#failures = 0;
		} catch (error) {
			if (!this.#running) return;
			this.#failures++;
			this.#onError(error);
		} finally {
			this.#polling = false;
			this.#schedule();
		}
	}

	#onVisibilityChange(): void {
		if (this.#visibility.hidden()) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		} else if (!this.#polling && this.#timer === undefined) {
			if (this.#failures === 0) void this.poll();
			else this.#schedule();
		}
	}

	#schedule(): void {
		if (!this.#running || this.#visibility.hidden()) return;
		const delay =
			this.#failures === 0 ? this.#pollIntervalMs : backoffDelay(this.#failures, this.#backoff, this.#random);
		this.#timer = setTimeout(() => void this.poll(), delay);
	}

	async #fetchManifest(signal?: AbortSignal): Promise<LiveManifest> {
		const response = await this.#fetch(this.manifestUrl.href, { signal });
		if (!response.ok) throw new Error(`${this.manifestUrl.href}: HTTP ${response.status}`);
		const manifest = (await response.json()) as LiveManifest;
		const major = Number(String(manifest.schema_version).split('.')[0]);
		if (major !== CONTRACT_MAJOR || !Array.isArray(manifest.chunks)) {
			throw new Error(`manifest version ${manifest.schema_version}, expected major ${CONTRACT_MAJOR}`);
		}
		return manifest;
	}

	/**
	 * Loads the recent chunks, calls `onRecent`, then leaves the older ones to a paced background
	 * load. An older chunk that fails is retried on a later poll without failing this one: the oldest
	 * listed chunk can already be deleted.
	 */
	async #fetchMissing(manifest: LiveManifest, signal: AbortSignal | undefined, onRecent: () => void): Promise<void> {
		const listed = new Map(manifest.chunks.map((ref) => [ref.path, ref]));
		for (const path of this.#seen) if (!listed.has(path)) this.#seen.delete(path);
		for (const path of this.#loaded.keys()) if (!listed.has(path)) this.#loaded.delete(path);

		const missing = manifest.chunks
			.filter((ref) => !this.#seen.has(ref.path) && !this.#backfilling.has(ref.path))
			.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
		const newest = Math.max(...manifest.chunks.map((ref) => Date.parse(ref.end)));
		const isRecent = (ref: ChunkRef) => Date.parse(ref.end) > newest - this.#recentMs;
		const recent = missing.filter(isRecent).reverse();
		const older = missing.filter((ref) => !isRecent(ref));

		let failure: unknown;
		const recentChunks = await this.#download(recent, this.#concurrency, signal);
		if (!this.#running) return;
		for (const [ref, result] of recentChunks) {
			if ('error' in result) failure ??= this.#reject(ref, result.error);
			else this.#accept([ref], result.chunk, [result.chunk]);
		}
		if (failure === undefined) onRecent();
		if (older.length > 0 && this.#backfill === undefined) {
			for (const ref of older) this.#backfilling.add(ref.path);
			this.#backfill = this.#loadOlder(older, signal).finally(() => {
				this.#backfilling.clear();
				this.#backfill = undefined;
			});
		}
		if (failure !== undefined) throw failure;
	}

	async #loadOlder(older: ChunkRef[], signal: AbortSignal | undefined): Promise<void> {
		for (let at = 0; at < older.length && this.#running; at += OLDER_BATCH) {
			const results = await this.#download(older.slice(at, at + OLDER_BATCH), OLDER_CONCURRENCY, signal, true);
			if (!this.#running) return;
			const refs: ChunkRef[] = [];
			const chunks: DecodedChunk[] = [];
			for (const [ref, result] of results) {
				if ('error' in result) {
					const error = this.#reject(ref, result.error);
					if (error !== undefined) this.#onError(error);
				} else {
					refs.push(ref);
					chunks.push(result.chunk);
				}
			}
			if (chunks.length > 0) this.#accept(refs, mergeChunks(chunks), chunks);
		}
	}

	/** Waits until an older chunk request fits the page's request budget and spacing. */
	async #admit(inFlight: () => number, signal: AbortSignal | undefined): Promise<void> {
		while (this.#running && this.#pressure() + inFlight() >= this.#olderBudget) await pause(PRESSURE_WAIT_MS, signal);
		if (this.#olderSpacingMs <= 0) return;
		const wait = this.#nextOlderAt - performance.now();
		this.#nextOlderAt = Math.max(performance.now(), this.#nextOlderAt) + this.#olderSpacingMs;
		if (wait > 0) await pause(wait, signal);
	}

	/** Downloads `refs` with at most `concurrency` requests in flight, results in `refs` order. */
	async #download(refs: ChunkRef[], concurrency: number, signal?: AbortSignal, paced = false): Promise<[ChunkRef, Download][]> {
		const results: Download[] = refs.map(() => ({ error: new Error('download stopped') }));
		let next = 0;
		let inFlight = 0;
		const worker = async () => {
			while (next < refs.length && this.#running) {
				if (paced) await this.#admit(() => inFlight, signal);
				if (next >= refs.length || !this.#running) return;
				const i = next++;
				inFlight++;
				try {
					results[i] = { chunk: await fetchChunk(new URL(refs[i].path, this.manifestUrl).href, this.#fetch, signal) };
				} catch (error) {
					results[i] = { error };
				} finally {
					inFlight--;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, worker));
		return refs.map((ref, i) => [ref, results[i]]);
	}

	/** Records a failed download; returns the error that should fail the poll, if any. */
	#reject(ref: ChunkRef, error: unknown): unknown {
		if (!(error instanceof ChunkFormatError)) return error;
		this.#seen.add(ref.path);
		this.#onError(error);
		return undefined;
	}

	#accept(refs: ChunkRef[], merged: DecodedChunk, chunks: DecodedChunk[]): void {
		for (const ref of refs) {
			this.#seen.add(ref.path);
			this.#loaded.set(ref.path, [Date.parse(ref.start), Date.parse(ref.end)]);
		}
		this.#ring.push(merged);
		chunks.forEach((chunk, i) => this.#onChunk?.(chunk, refs[i]));
	}
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** One chunk holding the flashes of `chunks`, with offsets from the earliest start. */
export function mergeChunks(chunks: DecodedChunk[]): DecodedChunk {
	if (chunks.length === 1) return chunks[0];
	const start = Math.min(...chunks.map((chunk) => chunk.start));
	const count = chunks.reduce((sum, chunk) => sum + chunk.count, 0);
	const columns = {} as Record<string, Int32Array | Int16Array | Uint16Array | Uint8Array>;
	for (const name of Object.keys(chunks[0].columns) as (keyof DecodedChunk['columns'])[]) {
		const Type = chunks[0].columns[name].constructor as new (length: number) => Int32Array;
		const column = new Type(count);
		let at = 0;
		for (const chunk of chunks) {
			const source = chunk.columns[name];
			if (name === 'event_offset_ms') for (let i = 0; i < chunk.count; i++) column[at + i] = source[i] + chunk.start - start;
			else column.set(source.subarray(0, chunk.count), at);
			at += chunk.count;
		}
		columns[name] = column;
	}
	return { start, count, columns: columns as unknown as DecodedChunk['columns'] };
}
