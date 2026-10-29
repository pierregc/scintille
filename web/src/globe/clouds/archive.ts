import type { Clouds } from './index';
import { CLOUD_MAX_GAP_MS } from './index';
import { type CloudFrame, loadCloudFrame } from './frame';
import { type CloudManifest, type CloudTier, parseCloudManifest } from './manifest';
import { type DetailSource, detailSource } from './detail';
import { boundedBody } from './response';
import { CLOUD_ARCHIVE_RULES as RULES } from '../../contract/cloud-archive';

const REFRESH_MS = 60_000;
/** Previews of a still scene are swapped for full frames once its frames stop changing for this long. */
const SETTLE_MS = 400;
/** Day indices kept in memory, so scrubbing back to a day reads none again. */
const CACHED_DAYS = 6;
const PREVIEW_TIER: CloudTier = '2k';
const TEXTURE_PATH = new RegExp(RULES.texture_path_pattern);
const DETAIL_PATH = new RegExp(RULES.detail_path_pattern);
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

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
	clouds: Pick<Clouds, 'setFrame' | 'retainFrames' | 'frameTimes'>;
	fetch?: typeof fetch;
	now: () => number;
	load?: (url: string, time: number, signal: AbortSignal) => Promise<CloudFrame>;
	/** Frames kept on the layer; the nearest to the scene time win. */
	frames?: number;
}

/** One archived frame: its texture in the feed's tier and, when that is finer, a lighter preview. */
interface Source {
	time: number;
	url: string;
	preview: string | null;
	detail: DetailSource | null;
	expires: number;
}

interface CachedDay {
	attribution: string | null;
	sources: Source[] | null;
	fetchedAt: number;
}

interface Load {
	request: AbortController;
	promise: Promise<void>;
	source: Source;
	url: string;
	upgrade: boolean;
}

/**
 * Archived frames near the scene time, nearest first. A missing frame of the blended pair comes
 * as a preview first, swapped for the full frame once the scene holds still. Stopping leaves the
 * frames on the layer, for the next feed to keep or replace.
 */
export class ArchiveCloudFeed {
	readonly #options: ArchiveCloudOptions;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #load: NonNullable<ArchiveCloudOptions['load']>;
	readonly #root: string;
	readonly #frames: number;
	readonly #days = new Map<string, CachedDay>();
	readonly #discovering = new Map<string, AbortController>();
	readonly #discovery = new Set<Promise<void>>();
	/** Layer frames this feed answers for: observation time to the URL shown. */
	readonly #held = new Map<number, string>();
	readonly #failed = new Map<string, number>();
	#time: number | undefined;
	#needed: string[] = [];
	#sources: Source[] = [];
	#wanted = '';
	#wantedSince = 0;
	#loading: Load | undefined;
	#attribution: string | null = null;

	constructor(options: ArchiveCloudOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now;
		this.#load = options.load ?? ((url, time, signal) => loadCloudFrame(url, time, undefined, signal));
		this.#root = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.#frames = Math.max(options.frames ?? 3, 1);
	}

	get settled(): boolean {
		return this.#time !== undefined && this.#discovering.size === 0 && !this.#loading && !this.#next(true);
	}
	get attribution(): string | null { return this.#attribution; }

	async idle(): Promise<void> {
		while (this.#discovery.size > 0 || this.#loading) {
			await Promise.allSettled([...this.#discovery, this.#loading?.promise]);
		}
	}

	setTime(time: number): void {
		if (!Number.isFinite(time)) return;
		this.#time = time;
		this.#needed = [...new Set([time - CLOUD_MAX_GAP_MS, time, time + CLOUD_MAX_GAP_MS].map(dayOf))];
		this.#discover();
		this.#select();
	}

	#discover(): void {
		const now = this.#now();
		for (const day of this.#needed) {
			const cached = this.#days.get(day);
			if (this.#discovering.has(day) || (cached && now - cached.fetchedAt < REFRESH_MS)) continue;
			const request = new AbortController();
			this.#discovering.set(day, request);
			const work = this.#fetchDay(day, request.signal).finally(() => {
				this.#discovery.delete(work);
				if (this.#discovering.get(day) === request) this.#discovering.delete(day);
				if (!request.signal.aborted) this.#select();
			});
			this.#discovery.add(work);
		}
	}

	async #fetchDay(day: string, signal: AbortSignal): Promise<void> {
		const url = new URL(`archive/clouds/manifests/${day}.json`, this.#root).href;
		let entry: CachedDay = { attribution: null, sources: null, fetchedAt: 0 };
		try {
			const response = await this.#fetch(url, { signal });
			if (!response.ok) throw new Error('cloud archive unavailable');
			const bytes = await boundedBody(response, RULES.max_manifest_bytes);
			const manifest = parseArchive(JSON.parse(new TextDecoder().decode(bytes)), day);
			entry = { attribution: manifest.attribution || null, sources: this.#sourcesOf(manifest, url), fetchedAt: 0 };
		} catch { if (signal.aborted) return; }
		if (signal.aborted) return;
		this.#days.delete(day);
		this.#days.set(day, { ...entry, fetchedAt: this.#now() });
		for (const old of this.#days.keys()) {
			if (this.#days.size <= CACHED_DAYS) break;
			if (!this.#needed.includes(old)) this.#days.delete(old);
		}
	}

	#sourcesOf(manifest: ArchiveManifest, manifestUrl: string): Source[] {
		const tier = this.#options.tier;
		return manifest.frames.flatMap((f) => {
			const texture = f.textures[tier];
			if (!texture) return [];
			const preview = tier !== PREVIEW_TIER ? f.textures[PREVIEW_TIER] : undefined;
			return [{
				time: Date.parse(f.time),
				url: new URL(texture.path, manifestUrl).href,
				preview: preview ? new URL(preview.path, manifestUrl).href : null,
				detail: detailSource(f.detail, manifestUrl),
				expires: Date.parse(f.expires_at),
			}];
		});
	}

	#select(): void {
		const time = this.#time;
		if (time === undefined) return;
		const now = this.#now();
		const days = this.#needed.map((day) => this.#days.get(day));
		const listed = days.flatMap((day) => day?.sources ?? [])
			.filter((s) => s.expires > now && Math.abs(s.time - time) <= CLOUD_MAX_GAP_MS)
			.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time));
		this.#sources = listed.slice(0, this.#frames);
		const wanted = this.#sources.map((s) => s.time).join();
		if (wanted !== this.#wanted) { this.#wanted = wanted; this.#wantedSince = now; }
		this.#attribution = days.find((day) => day?.attribution)?.attribution ?? null;

		// Frames already on the layer, such as the live ones when Travel in time opens, need no reload.
		const layer = this.#options.clouds.frameTimes;
		for (const t of this.#held.keys()) if (!layer.includes(t)) this.#held.delete(t);
		for (const s of listed) if (!this.#held.has(s.time) && layer.includes(s.time)) this.#held.set(s.time, s.url);
		// Unlisted frames go once the index of their day is read, and any frame too far to be shown.
		const read = (t: number) => Boolean(this.#days.get(dayOf(t))?.sources);
		const keep = layer.filter((t) => Math.abs(t - time) <= CLOUD_MAX_GAP_MS && (this.#held.has(t) || !read(t)));
		if (keep.length < layer.length) {
			for (const t of layer) if (!keep.includes(t)) this.#held.delete(t);
			this.#options.clouds.retainFrames(keep);
		}
		for (const url of this.#failed.keys()) if ((this.#failed.get(url) ?? 0) <= now) this.#failed.delete(url);

		const loading = this.#loading;
		if (loading && (Math.abs(loading.source.time - time) > CLOUD_MAX_GAP_MS || this.#yields(loading))) {
			loading.request.abort();
		}
		this.#loadNext();
	}

	/** A full frame outside the blended pair, or an upgrade, gives way to a missing frame of the pair. */
	#yields(load: Load): boolean {
		const pair = this.#sources.slice(0, 2);
		const full = load.source.preview !== null && load.url === load.source.url;
		const needed = !load.upgrade && pair.some((s) => s.time === load.source.time);
		return full && !needed && pair.some((s) => s.time !== load.source.time && !this.#held.has(s.time) && this.#missing(s) !== undefined);
	}

	#usable(url: string | null): url is string {
		return url !== null && !this.#failed.has(url);
	}

	/** URL to fetch for a frame not on the layer: its preview when there is one. */
	#missing(source: Source): string | undefined {
		if (this.#usable(source.preview)) return source.preview;
		return this.#usable(source.url) ? source.url : undefined;
	}

	/** The next texture to fetch: the blended pair (previews, then full frames once still), then the rest. */
	#next(ignoreSettle = false): { source: Source; url: string; upgrade: boolean } | undefined {
		const pair = this.#sources.slice(0, 2);
		for (const source of pair) {
			const url = this.#held.has(source.time) ? undefined : this.#missing(source);
			if (url) return { source, url, upgrade: false };
		}
		if (ignoreSettle || this.#now() - this.#wantedSince >= SETTLE_MS) {
			for (const source of pair) {
				const shown = this.#held.get(source.time);
				if (shown !== undefined && shown !== source.url && this.#usable(source.url)) return { source, url: source.url, upgrade: true };
			}
		}
		for (const source of this.#sources.slice(2)) {
			if (!this.#held.has(source.time) && this.#usable(source.url)) return { source, url: source.url, upgrade: false };
		}
		return undefined;
	}

	#loadNext(): void {
		if (this.#loading || this.#time === undefined) return;
		const job = this.#next();
		if (!job) return;
		const request = new AbortController();
		const work: Load = { ...job, request, promise: Promise.resolve() };
		this.#loading = work;
		work.promise = (async () => {
			try {
				const frame = await this.#load(job.url, job.source.time, request.signal);
				if (request.signal.aborted || !this.#place(frame, job.source, job.url)) frame.texture.dispose();
			} catch {
				if (!request.signal.aborted) this.#failed.set(job.url, this.#now() + REFRESH_MS);
			}
		})().finally(() => {
			if (this.#loading !== work) return;
			this.#loading = undefined;
			this.#loadNext();
		});
	}

	/** Puts a loaded frame on the layer, in place of the farthest one when it is full; false if it is not worth it. */
	#place(frame: CloudFrame, source: Source, url: string): boolean {
		const time = this.#time;
		if (time === undefined || Math.abs(source.time - time) > CLOUD_MAX_GAP_MS) return false;
		const layer = this.#options.clouds.frameTimes;
		if (!layer.includes(source.time) && layer.length >= this.#frames) {
			const distance = (t: number) => Math.abs(t - time);
			const farthest = layer.reduce((a, b) => (distance(b) > distance(a) ? b : a));
			if (distance(farthest) <= distance(source.time)) return false;
			this.#held.delete(farthest);
			this.#options.clouds.retainFrames(layer.filter((t) => t !== farthest));
		}
		this.#options.clouds.setFrame({ ...frame, detail: source.detail });
		this.#held.set(source.time, url);
		return true;
	}

	stop(): void {
		this.#time = undefined;
		for (const request of this.#discovering.values()) request.abort();
		this.#discovering.clear();
		this.#loading?.request.abort();
		this.#needed = [];
		this.#sources = [];
		this.#wanted = '';
		this.#attribution = null;
		this.#days.clear();
		this.#held.clear();
		this.#failed.clear();
	}
}
