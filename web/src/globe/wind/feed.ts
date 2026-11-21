import { WIND_RULES } from '../../contract/wind';
import { browserStorage, type PreferenceStorage } from '../clouds/preference';
import { boundedBody } from '../clouds/response';
import { blendPair, easePosition, framePosition } from '../clouds/timeline';
import { type Backoff, backoffDelay, DEFAULT_BACKOFF } from '../live/client';
import { loadWindField } from './field';
import { dayOf, parseWindArchive, parseWindManifest, type WindSource, windSources } from './manifest';
import { readWindLook, writeWindLook } from './preference';
import { WIND_LOOK_LEVEL, type WindField, type WindLayer, type WindLevel, type WindLook } from './types';

const HOUR = 3_600_000;
/** Beyond this distance from every frame, the scene time has no wind to show: the layer hides. */
export const WIND_MAX_GAP_MS = 3 * HOUR;
/** Frames further apart are not blended: the nearest shows alone. */
export const WIND_BLEND_MAX_GAP_MS = 3 * HOUR;
/** New frames come hourly. */
export const WIND_POLL_INTERVAL_MS = 5 * 60_000;
/** Textures loaded around the scene time: the pair around it, then the nearest other. */
export const WIND_FIELDS = 3;
/** Textures kept on the GPU; the farthest from the scene time go first. */
export const MAX_WIND_FIELDS = 4;
/** Live window until the manifest gives it. */
const LIVE_WINDOW_MS = 6 * HOUR;
const ARCHIVE_REFRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const CACHED_DAYS = 6;
/** The choice of frames reruns when the scene time moves this much, every second, or when data arrives. */
const RESYNC_SCENE_MS = 60_000;
const RESYNC_WALL_MS = 1_000;

export interface WindFeedOptions {
	/** Feed root, absolute: `live/wind/manifest.json` and `archive/wind/manifests/<day>.json` live under it. */
	baseUrl: string;
	layer: Pick<WindLayer, 'setLook' | 'setFields'>;
	/** Wall clock, UTC ms. */
	now: () => number;
	/** Where the look persists; null keeps it in memory only. */
	storage?: PreferenceStorage | null;
	fetch?: typeof fetch;
	load?: (source: WindSource, signal: AbortSignal) => Promise<WindField>;
	pollIntervalMs?: number;
	backoff?: Backoff;
	random?: () => number;
	onError?: (error: unknown) => void;
}

type Loaded = WindField & { url: string };

interface Listing {
	sources: WindSource[] | null;
	attribution: string | null;
	fetchedAt: number;
}

/**
 * Wind frames around the scene time, live or travelling in time: the live manifest while the scene
 * is within its window, the daily archive indexes before it. Downloads only the chosen look's level,
 * nothing while off, and owns the textures it hands to the layer.
 */
export class WindFeed {
	readonly #layer: WindFeedOptions['layer'];
	readonly #now: () => number;
	readonly #root: string;
	readonly #storage: PreferenceStorage | null;
	readonly #fetch: typeof fetch;
	readonly #load: NonNullable<WindFeedOptions['load']>;
	readonly #pollMs: number;
	readonly #backoff: Backoff;
	readonly #random: () => number;
	readonly #onError: (error: unknown) => void;
	readonly #days = new Map<string, Listing>();
	readonly #dayRequests = new Map<string, AbortController>();
	readonly #failed = new Map<string, number>();
	readonly #pending = new Set<Promise<void>>();
	#look: WindLook | null;
	#live: (Listing & { windowMs: number; start: number | null }) | null = null;
	#liveFetchedAt = -Infinity;
	#liveFailures = 0;
	#liveRequest: AbortController | undefined;
	#needed: string[] = [];
	#listed = new Set<string>();
	#wanted: WindSource[] = [];
	#fields: Loaded[] = [];
	#kept: Loaded[] = [];
	#loading: { url: string; request: AbortController } | undefined;
	#synced = { scene: Number.NaN, wall: Number.NaN };
	#dirty = true;
	#scene = Number.NaN;
	#wall = Number.NaN;
	#position = Number.NaN;
	#set: { a: WindField | null; b: WindField | null; mix: number } = { a: null, b: null, mix: 0 };
	#disposed = false;

	constructor(options: WindFeedOptions) {
		this.#layer = options.layer;
		this.#now = options.now;
		this.#root = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.#storage = options.storage === undefined ? browserStorage() : options.storage;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#load = options.load ?? loadWindField;
		this.#pollMs = options.pollIntervalMs ?? WIND_POLL_INTERVAL_MS;
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#random = options.random ?? Math.random;
		this.#onError = options.onError ?? (() => {});
		this.#look = readWindLook(this.#storage);
		this.#layer.setLook(this.#look);
	}

	/** The viewer's choice; null is off. */
	get look(): WindLook | null {
		return this.#look;
	}

	/** Whether a field is on the layer now. */
	get shown(): boolean {
		return this.#set.a !== null;
	}

	/** Attribution of the manifests read, or null. */
	get attribution(): string | null {
		return this.#live?.attribution ?? this.#needed.map((day) => this.#days.get(day)?.attribution).find(Boolean) ?? null;
	}

	/** Turns the layer on with a look, or off, and remembers the choice. */
	setLook(look: WindLook | null): void {
		if (this.#disposed || look === this.#look) return;
		const level = this.#level();
		this.#look = look;
		writeWindLook(this.#storage, look);
		this.#layer.setLook(look);
		if (!look) this.#stop();
		else if (this.#level() !== level) {
			this.#abortLoad();
			this.#clearFields();
			this.#dirty = true;
		}
	}

	/** Once per rendered frame: scene time, and the clock that eases the change between frames. */
	setTime(sceneMs: number, wallMs: number): void {
		if (!this.#look || this.#disposed || !Number.isFinite(sceneMs)) return;
		if (this.#dirty || !(Math.abs(sceneMs - this.#synced.scene) < RESYNC_SCENE_MS) || !(this.#now() - this.#synced.wall < RESYNC_WALL_MS)) {
			this.#sync(sceneMs);
		}
		this.#show(sceneMs, wallMs);
		this.#scene = sceneMs;
		this.#wall = wallMs;
	}

	/** Resolves once no request is in flight. */
	async idle(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
	}

	dispose(): void {
		this.#stop();
		this.#disposed = true;
	}

	#level(): WindLevel | null {
		return this.#look && WIND_LOOK_LEVEL[this.#look];
	}

	#sync(time: number): void {
		const now = this.#now();
		this.#refreshLive(time, now);
		this.#refreshArchive(time, now);
		this.#select(time, now);
		this.#startLoad();
		this.#synced = { scene: time, wall: now };
		this.#dirty = false;
	}

	#changed(): void {
		this.#dirty = true;
		if (this.#look && !this.#disposed && Number.isFinite(this.#scene)) this.#sync(this.#scene);
	}

	#track(work: Promise<void>): void {
		this.#pending.add(work);
		void work.finally(() => this.#pending.delete(work));
	}

	async #json(url: string, signal: AbortSignal): Promise<unknown> {
		const response = await this.#fetch(url, { signal });
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		return JSON.parse(new TextDecoder().decode(await boundedBody(response, WIND_RULES.max_manifest_bytes)));
	}

	/** Polls the live manifest while the scene time is near its window. */
	#refreshLive(time: number, now: number): void {
		const windowMs = this.#live?.windowMs ?? LIVE_WINDOW_MS;
		if (this.#liveRequest || time < now - windowMs - WIND_MAX_GAP_MS) return;
		const wait = this.#liveFailures === 0 ? this.#pollMs : backoffDelay(this.#liveFailures, this.#backoff, this.#random);
		if (now - this.#liveFetchedAt < wait) return;
		const request = new AbortController();
		this.#liveRequest = request;
		const url = new URL('live/wind/manifest.json', this.#root).href;
		this.#track((async () => {
			try {
				const manifest = parseWindManifest(await this.#json(url, request.signal));
				const sources = windSources(manifest.frames, url);
				this.#live = {
					sources,
					attribution: manifest.attribution || null,
					fetchedAt: this.#now(),
					windowMs: manifest.window_seconds * 1000,
					start: sources.length > 0 ? Math.min(...sources.map((s) => s.time)) : null,
				};
				this.#liveFailures = 0;
			} catch (error) {
				if (request.signal.aborted) return;
				this.#liveFailures++;
				this.#onError(error);
			} finally {
				if (this.#liveRequest === request) {
					this.#liveRequest = undefined;
					this.#liveFetchedAt = this.#now();
					this.#changed();
				}
			}
		})());
	}

	/** Reads the daily indexes around the scene time once it is older than the live window. */
	#refreshArchive(time: number, now: number): void {
		const start = this.#live?.start ?? now - (this.#live?.windowMs ?? LIVE_WINDOW_MS);
		const archived = time < start || (this.#live === null && this.#liveFailures > 0);
		const today = dayOf(now);
		this.#needed = archived
			? [...new Set([time - WIND_MAX_GAP_MS, time, time + WIND_MAX_GAP_MS].map(dayOf))].filter((day) => day <= today)
			: [];
		for (const day of this.#needed) {
			const cached = this.#days.get(day);
			if (this.#dayRequests.has(day) || (cached && now - cached.fetchedAt < ARCHIVE_REFRESH_MS)) continue;
			const request = new AbortController();
			this.#dayRequests.set(day, request);
			const url = new URL(`archive/wind/manifests/${day}.json`, this.#root).href;
			this.#track((async () => {
				let listing: Listing = { sources: null, attribution: null, fetchedAt: 0 };
				try {
					const manifest = parseWindArchive(await this.#json(url, request.signal), day);
					listing = { sources: windSources(manifest.frames, url), attribution: manifest.attribution || null, fetchedAt: 0 };
				} catch {
					// A day outside the archive is expected; it is read again later.
				} finally {
					if (this.#dayRequests.get(day) === request) {
						this.#dayRequests.delete(day);
						this.#days.delete(day);
						this.#days.set(day, { ...listing, fetchedAt: this.#now() });
						for (const old of this.#days.keys()) {
							if (this.#days.size <= CACHED_DAYS) break;
							if (!this.#needed.includes(old)) this.#days.delete(old);
						}
						this.#changed();
					}
				}
			})());
		}
	}

	/** The frames to load: the pair around the scene time first, then the nearest others. */
	#select(time: number, now: number): void {
		const level = this.#level();
		const byTime = new Map<number, WindSource>();
		for (const listing of [this.#live, ...this.#needed.map((day) => this.#days.get(day))]) {
			for (const s of listing?.sources ?? []) {
				if (s.level === level && s.expires > now && Math.abs(s.time - time) <= WIND_MAX_GAP_MS && !byTime.has(s.time)) byTime.set(s.time, s);
			}
		}
		const listed = [...byTime.values()].sort((x, y) => x.time - y.time);
		const distance = (s: WindSource) => Math.abs(s.time - time);
		const next = listed.findIndex((s) => s.time > time);
		const pair = [listed[(next < 0 ? listed.length : next) - 1], next < 0 ? undefined : listed[next]]
			.filter((s): s is WindSource => s !== undefined)
			.sort((x, y) => distance(x) - distance(y));
		const rest = listed.filter((s) => !pair.includes(s)).sort((x, y) => distance(x) - distance(y));
		this.#listed = new Set(listed.map((s) => s.url));
		this.#wanted = [...pair, ...rest].slice(0, WIND_FIELDS);
	}

	/** One texture at a time, nearest first; a load no longer wanted is cancelled. */
	#startLoad(): void {
		const current = this.#loading;
		if (current && this.#wanted.some((s) => s.url === current.url)) return;
		this.#abortLoad();
		// Until every day within reach is read, the nearest frame may be in a missing one.
		if (this.#needed.some((day) => !this.#days.has(day))) return;
		const now = this.#now();
		for (const [url, until] of this.#failed) if (until <= now) this.#failed.delete(url);
		const source = this.#wanted.find((s) => !this.#failed.has(s.url) && !this.#fields.some((f) => f.url === s.url));
		if (!source) return;
		const job = { url: source.url, request: new AbortController() };
		this.#loading = job;
		this.#track((async () => {
			try {
				const field = await this.#load(source, job.request.signal);
				if (this.#loading === job) this.#fields.push({ ...field, url: source.url });
				else field.texture.dispose();
			} catch (error) {
				if (job.request.signal.aborted) return;
				this.#failed.set(source.url, this.#now() + RETRY_MS);
				this.#onError(error);
			} finally {
				if (this.#loading === job) {
					this.#loading = undefined;
					this.#changed();
				}
			}
		})());
	}

	/** Hands the layer the fields around the scene time, then disposes the textures it no longer needs. */
	#show(time: number, wall: number): void {
		const level = this.#level();
		const distance = (f: Loaded) => Math.abs(f.time - time);
		const byTime = new Map<number, Loaded>();
		for (const f of this.#fields) {
			if (f.level !== level || distance(f) > WIND_MAX_GAP_MS) continue;
			const held = byTime.get(f.time);
			if (!held || (!this.#listed.has(held.url) && this.#listed.has(f.url))) byTime.set(f.time, f);
		}
		const wanted = new Set(this.#wanted.map((s) => s.url));
		const rank = (f: Loaded) => (wanted.has(f.url) ? 0 : 1);
		const kept = [...byTime.values()]
			.sort((x, y) => rank(x) - rank(y) || distance(x) - distance(y))
			.slice(0, MAX_WIND_FIELDS)
			.sort((x, y) => x.time - y.time);
		const times = kept.map((f) => f.time);
		if (kept.length !== this.#kept.length || kept.some((f, i) => f !== this.#kept[i])) {
			// Keep showing the same instant across the change; the ease then moves to the new target.
			const { a, b, mix } = this.#set;
			const shown = a && b ? a.time + (b.time - a.time) * mix : Number.NaN;
			this.#position = Number.isFinite(shown) && kept.length > 0 ? framePosition(times, shown, WIND_BLEND_MAX_GAP_MS) : Number.NaN;
			this.#kept = kept;
		}
		if (kept.length === 0) {
			this.#setFields(null, null, 0);
		} else {
			const dt = Math.max(Math.abs(time - this.#scene), Math.abs(wall - this.#wall)) / 1000;
			this.#position = easePosition(this.#position, framePosition(times, time, WIND_BLEND_MAX_GAP_MS), Number.isFinite(dt) ? dt : 0);
			const { a, b, mix } = blendPair(this.#position, kept.length);
			this.#setFields(kept[a], kept[b], mix);
		}
		if (this.#fields.length > kept.length) {
			const dropped = this.#fields.filter((f) => !kept.includes(f));
			this.#fields = [...kept];
			for (const f of dropped) f.texture.dispose();
		}
	}

	#setFields(a: WindField | null, b: WindField | null, mix: number): void {
		const set = this.#set;
		if (set.a === a && set.b === b && set.mix === mix) return;
		this.#set = { a, b, mix };
		this.#layer.setFields(a, b, mix);
	}

	#abortLoad(): void {
		this.#loading?.request.abort();
		this.#loading = undefined;
	}

	#clearFields(): void {
		this.#setFields(null, null, 0);
		for (const f of this.#fields.splice(0)) f.texture.dispose();
		this.#kept = [];
		this.#wanted = [];
		this.#position = Number.NaN;
	}

	#stop(): void {
		this.#liveRequest?.abort();
		this.#liveRequest = undefined;
		for (const request of this.#dayRequests.values()) request.abort();
		this.#dayRequests.clear();
		this.#abortLoad();
		this.#clearFields();
		this.#needed = [];
		this.#dirty = true;
	}
}
