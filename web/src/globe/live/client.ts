import type { LiveManifest } from '../../contract/types';
import { CONTRACT_MAJOR, ChunkFormatError, fetchChunk, type DecodedChunk } from './decode';
import type { FlashRing } from './ring';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface Backoff {
	initialMs: number;
	maxMs: number;
}

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
	fetch?: typeof fetch;
	visibility?: Visibility;
	random?: () => number;
	onManifest?: (manifest: LiveManifest) => void;
	onError?: (error: unknown) => void;
}

/** Polls the live manifest and pushes every chunk it has not seen yet into the ring, once. */
export class LiveClient {
	readonly manifestUrl: URL;
	readonly #ring: FlashRing;
	readonly #pollIntervalMs: number;
	readonly #backoff: Backoff;
	readonly #concurrency: number;
	readonly #fetch: typeof fetch;
	readonly #visibility: Visibility;
	readonly #random: () => number;
	readonly #onManifest?: (manifest: LiveManifest) => void;
	readonly #onError: (error: unknown) => void;
	readonly #seen = new Set<string>();
	#failures = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#polling = false;
	#inFlight: Promise<void> | undefined;
	#running = false;
	#abort: AbortController | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(options: LiveClientOptions) {
		const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.manifestUrl = new URL('live/manifest.json', base);
		this.#ring = options.ring;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#concurrency = options.concurrency ?? 6;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#visibility = options.visibility ?? documentVisibility;
		this.#random = options.random ?? Math.random;
		this.#onManifest = options.onManifest;
		this.#onError = options.onError ?? (() => {});
	}

	/** Consecutive failed polls. */
	get failures(): number {
		return this.#failures;
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

	/** Resolves once the current poll, if any, has finished. */
	idle(): Promise<void> {
		return this.#inFlight ?? Promise.resolve();
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
			await this.#fetchMissing(manifest, signal);
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

	async #fetchMissing(manifest: LiveManifest, signal?: AbortSignal): Promise<void> {
		const listed = new Set(manifest.chunks.map((ref) => ref.path));
		for (const path of this.#seen) if (!listed.has(path)) this.#seen.delete(path);

		const missing = [...listed].filter((path) => !this.#seen.has(path));
		let failure: unknown;
		for (let i = 0; i < missing.length && this.#running; i += this.#concurrency) {
			const batch = missing.slice(i, i + this.#concurrency);
			const results = await Promise.allSettled(
				batch.map((path) => fetchChunk(new URL(path, this.manifestUrl).href, this.#fetch, signal)),
			);
			if (!this.#running) return;
			results.forEach((result, j) => {
				if (result.status === 'fulfilled') this.#accept(batch[j], result.value);
				else if (result.reason instanceof ChunkFormatError) {
					this.#seen.add(batch[j]);
					this.#onError(result.reason);
				} else failure ??= result.reason;
			});
			if (failure !== undefined) throw failure;
		}
	}

	#accept(path: string, chunk: DecodedChunk): void {
		this.#seen.add(path);
		this.#ring.push(chunk);
	}
}
