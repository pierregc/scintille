import type { Clouds } from './index';
import { CLOUD_MAX_GAP_MS } from './index';
import { type CloudFrame, loadCloudFrame } from './frame';
import { type CloudFrameSource, type CloudManifest, type CloudTier, frameSources, parseCloudManifest } from './manifest';
import { boundedBody } from './response';
import { CLOUD_ARCHIVE_RULES as RULES } from '../../contract/cloud-archive';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REFRESH_MS = 60_000;
const TEXTURE_PATH = new RegExp(RULES.texture_path_pattern);
const DETAIL_PATH = new RegExp(RULES.detail_path_pattern);

interface ArchiveManifest extends Omit<CloudManifest, 'window_seconds'> {
	schema_version: number;
	day: string;
	frames: (CloudManifest['frames'][number] & { expires_at: string })[];
}

export function parseArchive(json: unknown, day: string): ArchiveManifest {
	parseCloudManifest(json);
	const manifest = json as ArchiveManifest;
	if (manifest.schema_version !== RULES.schema_version || manifest.day !== day || manifest.frames.length > RULES.max_frames) {
		throw new Error('invalid archive cloud manifest');
	}
	for (const frame of manifest.frames) {
		if (new Date(frame.time).toISOString().slice(0, 10) !== day ||
			!Number.isFinite(Date.parse(frame.expires_at))) throw new Error('invalid archive cloud frame');
		if (frame.detail && !DETAIL_PATH.test(frame.detail.path)) frame.detail = null;
		for (const [tier, texture] of Object.entries(frame.textures)) {
			if (!texture || !RULES.tiers.includes(tier) ||
				!TEXTURE_PATH.test(texture.path) ||
				!Number.isSafeInteger(texture.size_bytes) || texture.size_bytes < 1 || texture.size_bytes > RULES.max_frame_bytes) {
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

interface CachedDay {
	manifest: ArchiveManifest | null;
	fetchedAt: number;
}

interface Work {
	request: AbortController;
	promise: Promise<void>;
	key: string;
}

/** Metadata refresh and texture loading have independent cancellation lifetimes. */
export class ArchiveCloudFeed {
	readonly #options: ArchiveCloudOptions;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #load: NonNullable<ArchiveCloudOptions['load']>;
	readonly #root: string;
	readonly #manifests = new Map<string, CachedDay>();
	readonly #loaded = new Map<string, number>();
	readonly #failed = new Map<string, number>();
	#time: number | undefined;
	#days: string[] = [];
	#sources: CloudFrameSource[] = [];
	#discovery: Work | undefined;
	#loading: Work | undefined;
	#attribution: string | null = null;

	constructor(options: ArchiveCloudOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now;
		this.#load = options.load ?? ((url, time, signal) => loadCloudFrame(url, time, undefined, signal));
		this.#root = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
	}

	get settled(): boolean {
		return this.#time !== undefined && !this.#discovery && !this.#loading;
	}
	get attribution(): string | null { return this.#attribution; }

	async idle(): Promise<void> {
		while (this.#discovery || this.#loading) {
			await Promise.allSettled([this.#discovery?.promise, this.#loading?.promise]);
		}
	}

	setTime(time: number): void {
		if (!Number.isFinite(time)) return;
		this.#time = time;
		this.#days = [-DAY, 0, DAY].map((offset) => new Date(time + offset).toISOString().slice(0, 10));
		for (const day of this.#manifests.keys()) if (!this.#days.includes(day)) this.#manifests.delete(day);
		this.#select();
		this.#refresh();
	}

	#refresh(): void {
		if (this.#time === undefined) return;
		const key = this.#days.join(',');
		if (this.#discovery) {
			if (this.#discovery.key !== key) this.#discovery.request.abort();
			return;
		}
		const days = this.#days.filter((day) => {
			const cached = this.#manifests.get(day);
			return !cached || this.#now() - cached.fetchedAt >= REFRESH_MS;
		});
		if (days.length === 0) return;
		const request = new AbortController();
		const work: Work = { key, request, promise: Promise.resolve() };
		this.#discovery = work;
		work.promise = this.#discover(days, request.signal).finally(() => {
			if (this.#discovery !== work) return;
			this.#discovery = undefined;
			if (this.#time !== undefined) {
				this.#select();
				if (request.signal.aborted) this.#refresh();
			}
		});
	}

	async #discover(days: string[], signal: AbortSignal): Promise<void> {
		for (const day of days) {
			if (signal.aborted) return;
			let manifest: ArchiveManifest | null = null;
			try {
				const response = await this.#fetch(new URL(`archive/clouds/manifests/${day}.json`, this.#root).href, { signal });
				if (!response.ok) throw new Error('cloud archive unavailable');
				const bytes = await boundedBody(response, RULES.max_manifest_bytes);
				manifest = parseArchive(JSON.parse(new TextDecoder().decode(bytes)), day);
			} catch { if (signal.aborted) return; }
			if (signal.aborted) return;
			this.#manifests.set(day, { manifest, fetchedAt: this.#now() });
		}
	}

	#select(): void {
		const time = this.#time;
		if (time === undefined) return;
		this.#sources = this.#days.flatMap((day) => {
			const manifest = this.#manifests.get(day)?.manifest;
			if (!manifest) return [];
			const frames = manifest.frames.filter((f) => Date.parse(f.expires_at) > this.#now());
			return frameSources({ frames }, this.#options.tier,
				new URL(`archive/clouds/manifests/${day}.json`, this.#root).href, RULES.max_frames);
		}).filter((f) => Math.abs(f.time - time) <= CLOUD_MAX_GAP_MS)
			.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time)).slice(0, 3);
		const urls = new Set(this.#sources.map((s) => s.url));
		let removed = false;
		for (const url of this.#loaded.keys()) {
			if (!urls.has(url)) { this.#loaded.delete(url); removed = true; }
		}
		if (removed) this.#options.clouds.retainFrames([...this.#loaded.values()]);
		for (const url of this.#failed.keys()) if (!urls.has(url)) this.#failed.delete(url);
		if (this.#loading && !urls.has(this.#loading.key)) this.#loading.request.abort();
		this.#attribution = this.#days.map((d) => this.#manifests.get(d)?.manifest?.attribution).find(Boolean) ?? null;
		this.#loadNext();
	}

	#loadNext(): void {
		if (this.#loading || this.#time === undefined) return;
		const source = this.#sources.find((s) => !this.#loaded.has(s.url) &&
			(this.#failed.get(s.url) ?? 0) <= this.#now());
		if (!source) return;
		const request = new AbortController();
		const work: Work = { key: source.url, request, promise: Promise.resolve() };
		this.#loading = work;
		work.promise = (async () => {
			try {
				const frame = await this.#load(source.url, source.time, request.signal);
				if (request.signal.aborted || !this.#sources.some((s) => s.url === source.url)) {
					frame.texture.dispose(); return;
				}
				this.#loaded.set(source.url, source.time);
				this.#options.clouds.setFrame({ ...frame, detail: source.detail });
			} catch {
				if (!request.signal.aborted) this.#failed.set(source.url, this.#now() + REFRESH_MS);
			}
		})().finally(() => {
			if (this.#loading !== work) return;
			this.#loading = undefined;
			this.#loadNext();
		});
	}

	stop(): void {
		this.#time = undefined;
		this.#discovery?.request.abort();
		this.#loading?.request.abort();
		this.#days = [];
		this.#sources = [];
		this.#attribution = null;
		this.#manifests.clear();
		this.#loaded.clear();
		this.#failed.clear();
		this.#options.clouds.retainFrames([]);
	}
}
