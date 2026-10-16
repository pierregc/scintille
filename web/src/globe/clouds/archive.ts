import type { Clouds } from './index';
import { CLOUD_MAX_GAP_MS } from './index';
import { type CloudFrame, loadCloudFrame } from './frame';
import { type CloudManifest, type CloudTier, frameSources, parseCloudManifest } from './manifest';
import { boundedBody } from './response';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface ArchiveManifest extends Omit<CloudManifest, 'window_seconds'> {
	schema_version: 1;
	day: string;
	frames: (CloudManifest['frames'][number] & { expires_at: string })[];
}

function parseArchive(json: unknown, day: string): ArchiveManifest {
	parseCloudManifest(json);
	const manifest = json as ArchiveManifest;
	if (manifest.schema_version !== 1 || manifest.day !== day || manifest.frames.length > 96) {
		throw new Error('invalid archive cloud manifest');
	}
	for (const frame of manifest.frames) {
		if (new Date(frame.time).toISOString().slice(0, 10) !== day ||
			!Number.isFinite(Date.parse(frame.expires_at))) throw new Error('invalid archive cloud frame');
		for (const [tier, texture] of Object.entries(frame.textures)) {
			if (!texture || !['2k', '4k'].includes(tier) ||
				!/^\.\.\/(2k|4k)\/\d{4}\/\d{2}\/\d{2}\/[\w-]+\.webp$/.test(texture.path) ||
				!Number.isSafeInteger(texture.size_bytes) || texture.size_bytes < 1 || texture.size_bytes > MAX_FRAME_BYTES) {
				throw new Error('invalid archive cloud texture');
			}
		}
	}
	return manifest;
}

export interface ArchiveCloudOptions {
	baseUrl: string;
	tier: CloudTier;
	clouds: Pick<Clouds, 'setFrame' | 'retainFrames'>;
	fetch?: typeof fetch;
	now: () => number;
	load?: (url: string, time: number, signal: AbortSignal) => Promise<CloudFrame>;
}

/** At most three daily indices and three textures around the playhead; no bucket listing. */
export class ArchiveCloudFeed {
	readonly #options: ArchiveCloudOptions;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #load: NonNullable<ArchiveCloudOptions['load']>;
	readonly #manifests = new Map<string, ArchiveManifest | null>();
	readonly #loaded = new Map<string, number>();
	#request: AbortController | undefined;
	#window = '';
	#baseUrl: string;
	#pending: Promise<void> = Promise.resolve();
	#desired: { time: number; request: AbortController } | undefined;
	#running = false;
	#settled = false;
	#attribution: string | null = null;

	constructor(options: ArchiveCloudOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now;
		this.#load = options.load ?? ((url, time, signal) => loadCloudFrame(url, time, undefined, signal));
		this.#baseUrl = options.baseUrl;
	}

	get settled(): boolean { return this.#settled; }
	get attribution(): string | null { return this.#attribution; }
	idle(): Promise<void> { return this.#pending; }

	/** A fixture or future storm entry may use a different data root. */
	setBaseUrl(baseUrl: string): void {
		if (baseUrl === this.#baseUrl) return;
		this.stop();
		this.#baseUrl = baseUrl;
	}

	setTime(time: number): void {
		if (!Number.isFinite(time)) return;
		const window = `${Math.floor(time / HOUR)}:${Math.floor(this.#now() / 60_000)}`;
		if (window === this.#window) return;
		this.#window = window;
		this.#request?.abort();
		const request = new AbortController();
		this.#request = request;
		this.#settled = false;
		this.#desired = { time, request };
		if (!this.#running) this.#pending = this.#drain();
	}

	async #drain(): Promise<void> {
		this.#running = true;
		try {
			while (this.#desired) {
				const { time, request } = this.#desired;
				this.#desired = undefined;
				try { await this.#update(time, request); }
				catch { if (!request.signal.aborted) this.#settled = true; }
			}
		} finally { this.#running = false; }
	}

	async #update(time: number, request: AbortController): Promise<void> {
		const { signal } = request;
		if (signal.aborted) return;
		const days = [-DAY, 0, DAY].map((offset) => new Date(time + offset).toISOString().slice(0, 10));
		const root = this.#baseUrl.endsWith('/') ? this.#baseUrl : `${this.#baseUrl}/`;
		// Refresh the small daily indices once a minute, including negative lookups.
		this.#manifests.clear();
		for (const day of days) {
			if (this.#manifests.has(day)) continue;
			const url = new URL(`archive/clouds/manifests/${day}.json`, root);
			try {
				const response = await this.#fetch(url.href, { signal });
				if (!response.ok) throw new Error('cloud archive unavailable');
				const text = new TextDecoder().decode(await boundedBody(response, MAX_MANIFEST_BYTES));
				const manifest = parseArchive(JSON.parse(text), day);
				if (signal.aborted) return;
				this.#manifests.set(day, manifest);
			} catch {
				if (signal.aborted) return;
				this.#manifests.set(day, null);
			}
		}
		const sources = days.flatMap((day) => {
			const manifest = this.#manifests.get(day);
			if (!manifest) return [];
			const usable = { ...manifest, frames: manifest.frames.filter((f) => Date.parse(f.expires_at) > this.#now()) };
			return frameSources(usable, this.#options.tier,
				new URL(`archive/clouds/manifests/${day}.json`, root).href, 96);
		}).filter((f) => Math.abs(f.time - time) <= CLOUD_MAX_GAP_MS)
			.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time)).slice(0, 3);
		const urls = new Set(sources.map((s) => s.url));
		for (const url of this.#loaded.keys()) if (!urls.has(url)) this.#loaded.delete(url);
		this.#options.clouds.retainFrames([...this.#loaded.values()]);
		for (const source of sources) {
			if (signal.aborted) return;
			if (this.#loaded.has(source.url)) continue;
			try {
				const frame = await this.#load(source.url, source.time, signal);
				if (signal.aborted) { frame.texture.dispose(); return; }
				this.#loaded.set(source.url, source.time);
				this.#options.clouds.setFrame(frame);
			} catch { if (signal.aborted) return; }
		}
		this.#attribution = days.map((d) => this.#manifests.get(d)?.attribution).find(Boolean) ?? null;
		this.#settled = true;
	}

	stop(): void {
		this.#request?.abort();
		this.#request = undefined;
		this.#desired = undefined;
		this.#window = '';
		this.#settled = false;
		this.#attribution = null;
		this.#manifests.clear();
		this.#loaded.clear();
		this.#options.clouds.retainFrames([]);
	}
}
