import { type Backoff, backoffDelay, DEFAULT_BACKOFF, documentVisibility, type Visibility } from '../live/client';
import { type CloudFrame, loadCloudFrame } from './frame';
import { type CloudManifest, type CloudTier, frameSources, parseCloudManifest } from './manifest';

/** New frames appear about once an hour; the manifest is cached for 60 s. */
export const CLOUD_POLL_INTERVAL_MS = 60_000;

/** Frames kept loaded: enough to cover the live lightning hour, given the 40 to 100 min cloud lag. */
export const LIVE_CLOUD_FRAMES = 3;

export interface CloudFeedOptions {
	/** Live feed root; the manifest is at `<baseUrl>/live/clouds/manifest.json`. Must be absolute. */
	baseUrl: string;
	tier: CloudTier;
	/** Receives each loaded frame and owns its texture. */
	onFrame: (frame: CloudFrame) => void;
	frames?: number;
	pollIntervalMs?: number;
	backoff?: Backoff;
	fetch?: typeof fetch;
	visibility?: Visibility;
	random?: () => number;
	load?: (url: string, time: number) => Promise<CloudFrame>;
	onError?: (error: unknown) => void;
}

/** Polls the cloud manifest and loads the newest frames of one tier, once each. */
export class CloudFeed {
	readonly manifestUrl: URL;
	readonly #tier: CloudTier;
	readonly #onFrame: (frame: CloudFrame) => void;
	readonly #frames: number;
	readonly #pollIntervalMs: number;
	readonly #backoff: Backoff;
	readonly #fetch: typeof fetch;
	readonly #visibility: Visibility;
	readonly #random: () => number;
	readonly #load: (url: string, time: number) => Promise<CloudFrame>;
	readonly #onError: (error: unknown) => void;
	readonly #loaded = new Set<string>();
	#manifest: CloudManifest | null = null;
	#failures = 0;
	#settled = false;
	#running = false;
	#polling = false;
	#inFlight: Promise<void> | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#abort: AbortController | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(options: CloudFeedOptions) {
		const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.manifestUrl = new URL('live/clouds/manifest.json', base);
		this.#tier = options.tier;
		this.#onFrame = options.onFrame;
		this.#frames = options.frames ?? LIVE_CLOUD_FRAMES;
		this.#pollIntervalMs = options.pollIntervalMs ?? CLOUD_POLL_INTERVAL_MS;
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#visibility = options.visibility ?? documentVisibility;
		this.#random = options.random ?? Math.random;
		this.#load = options.load ?? ((url, time) => loadCloudFrame(url, time));
		this.#onError = options.onError ?? (() => {});
	}

	/** Latest manifest read, or null. */
	get manifest(): CloudManifest | null {
		return this.#manifest;
	}

	/** Attribution of the latest manifest, or null. */
	get attribution(): string | null {
		return this.#manifest?.attribution || null;
	}

	/** Consecutive failed polls. */
	get failures(): number {
		return this.#failures;
	}

	/** Whether a poll has finished, successfully or not. */
	get settled(): boolean {
		return this.#settled;
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

	/** Fetches the manifest and every missing frame. Concurrent calls are ignored. */
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
			const response = await this.#fetch(this.manifestUrl.href, { signal });
			if (!response.ok) throw new Error(`${this.manifestUrl.href}: HTTP ${response.status}`);
			const manifest = parseCloudManifest(await response.json());
			if (!this.#running) return;
			this.#manifest = manifest;
			const sources = frameSources(manifest, this.#tier, this.manifestUrl.href, this.#frames);
			const listed = new Set(sources.map((s) => s.url));
			for (const url of this.#loaded) if (!listed.has(url)) this.#loaded.delete(url);
			let frameError: unknown;
			for (const source of sources.toReversed()) {
				if (this.#loaded.has(source.url)) continue;
				let frame: CloudFrame;
				try {
					frame = await this.#load(source.url, source.time);
				} catch (error) {
					frameError ??= error;
					continue;
				}
				if (!this.#running) {
					frame.texture.dispose();
					return;
				}
				this.#loaded.add(source.url);
				this.#onFrame(frame);
			}
			if (frameError !== undefined) throw frameError;
			this.#failures = 0;
		} catch (error) {
			if (!this.#running) return;
			this.#failures++;
			this.#onError(error);
		} finally {
			this.#polling = false;
			this.#settled = true;
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
}
