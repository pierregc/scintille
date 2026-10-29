import { FLASH_ARCHIVE_RULES as RULES } from '../../contract/flash-archive';
import { boundedBody } from '../clouds/response';
import { fetchChunk, type DecodedChunk } from '../live/decode';
import type { FlashRing } from '../live/ring';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REFRESH_MS = 60_000;
const INDEX_REFRESH_MS = 600_000;
const RETRY_MS = 30_000;
const PREFETCH = 3;
const CHUNK_PATH = new RegExp(RULES.chunk_path_pattern);
/** Flashes kept behind the playhead: the longest display window and a margin. */
export const KEEP_BEHIND_MS = 35 * 60_000;
/** How far ahead of the playhead chunks enter the ring. */
export const LOOK_AHEAD_MS = 20 * 60_000;

export interface ArchiveChunkRef {
	url: string;
	hour: number;
	/** Last chunk of its hour. */
	last: boolean;
	flashCount: number;
	sizeBytes: number;
	eventMin: number;
	eventMax: number;
}

export interface ArchiveIndex {
	/** UTC midnight of the first archived day. */
	firstDay: number;
	lastHour: number;
}

export function utcDay(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;

/** Chunks of a day index, oldest first; throws on anything outside the archive rules. */
export function parseDay(json: unknown, day: string, manifestUrl: string): ArchiveChunkRef[] {
	const fail = () => { throw new Error('invalid flash archive day'); };
	if (!isObject(json) || json.schema_version !== RULES.schema_version || json.day !== day || !Array.isArray(json.hours)) fail();
	const refs: ArchiveChunkRef[] = [];
	const dayStart = Date.parse(`${day}T00:00:00Z`);
	let previous = -Infinity;
	for (const hour of (json as { hours: unknown[] }).hours) {
		if (!isObject(hour) || typeof hour.start !== 'string' || !Array.isArray(hour.chunks)) fail();
		const h = hour as { start: string; chunks: unknown[] };
		const start = Date.parse(h.start);
		if (!(start >= dayStart && start < dayStart + DAY && start % HOUR === 0 && start > previous) ||
			h.chunks.length < 1 || h.chunks.length > RULES.max_hour_chunks) fail();
		previous = start;
		h.chunks.forEach((chunk, i) => {
			if (!isObject(chunk) || typeof chunk.path !== 'string' || !CHUNK_PATH.test(chunk.path) ||
				!count(chunk.flash_count, RULES.chunk_flashes) || !count(chunk.size_bytes, RULES.max_chunk_bytes)) fail();
			const c = chunk as { path: string; flash_count: number; size_bytes: number; event_min: unknown; event_max: unknown };
			const eventMin = Date.parse(String(c.event_min));
			const eventMax = Date.parse(String(c.event_max));
			if (!(eventMin >= start && eventMax >= eventMin && eventMax < start + HOUR)) fail();
			refs.push({
				url: new URL(c.path, manifestUrl).href,
				hour: start,
				last: i === h.chunks.length - 1,
				flashCount: c.flash_count,
				sizeBytes: c.size_bytes,
				eventMin,
				eventMax,
			});
		});
	}
	return refs;
}

export function parseIndex(json: unknown): ArchiveIndex {
	if (!isObject(json) || json.schema_version !== RULES.schema_version || typeof json.first_day !== 'string') {
		throw new Error('invalid flash archive index');
	}
	const firstDay = Date.parse(`${json.first_day}T00:00:00Z`);
	const lastHour = Date.parse(String(json.last_hour));
	if (!Number.isFinite(firstDay) || !Number.isFinite(lastHour)) throw new Error('invalid flash archive index');
	return { firstDay, lastHour };
}

export interface FlashDaysOptions {
	/** Data root; indexes are under `archive/flashes/`. */
	baseUrl: string;
	fetch?: typeof fetch;
	/** Wall clock, UTC ms. */
	now: () => number;
}

interface CachedDay {
	refs: ArchiveChunkRef[] | null;
	fetchedAt: number;
}

/** Day indexes and the archive index, each cached for a short wall time, failures included. */
export class FlashDays {
	readonly #root: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #days = new Map<string, CachedDay>();
	readonly #loading = new Set<string>();
	#index: { value: ArchiveIndex | null; fetchedAt: number } | undefined;
	#indexLoading = false;

	constructor(options: FlashDaysOptions) {
		this.#root = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#now = options.now;
	}

	/** A day's chunks; null when it has no archive, undefined until its index arrives. */
	day(day: string): ArchiveChunkRef[] | null | undefined {
		const cached = this.#days.get(day);
		if (!this.#loading.has(day) && (!cached || this.#now() - cached.fetchedAt >= REFRESH_MS)) void this.#load(day);
		return cached?.refs;
	}

	/** Downloads and checks one chunk. */
	async chunk(ref: ArchiveChunkRef, signal: AbortSignal): Promise<DecodedChunk> {
		const chunk = await fetchChunk(ref.url, this.#fetch, signal, { stored: ref.sizeBytes, decoded: 2 * 1024 * 1024 });
		if (chunk.count !== ref.flashCount || chunk.start !== ref.hour) throw new Error(`flash archive chunk mismatch: ${ref.url}`);
		return chunk;
	}

	/** Forgets a day, after one of its chunks went missing. */
	invalidate(day: string): void {
		this.#days.delete(day);
	}

	/** Keeps only these days. */
	retain(days: readonly string[]): void {
		for (const day of this.#days.keys()) if (!days.includes(day)) this.#days.delete(day);
	}

	/** First archived day and last archived hour, once known. */
	index(): ArchiveIndex | null {
		if (!this.#indexLoading && (!this.#index || this.#now() - this.#index.fetchedAt >= INDEX_REFRESH_MS)) void this.#loadIndex();
		return this.#index?.value ?? null;
	}

	async #json(path: string): Promise<unknown> {
		const response = await this.#fetch(new URL(path, this.#root).href);
		if (!response.ok) throw new Error(`flash archive: HTTP ${response.status}`);
		const bytes = await boundedBody(response, RULES.max_manifest_bytes);
		return JSON.parse(new TextDecoder().decode(bytes));
	}

	async #load(day: string): Promise<void> {
		this.#loading.add(day);
		const path = `archive/flashes/manifests/${day}.json`;
		let refs: ArchiveChunkRef[] | null = null;
		try {
			refs = parseDay(await this.#json(path), day, new URL(path, this.#root).href);
		} catch { /* a missing or invalid day has no archive */ }
		this.#days.set(day, { refs, fetchedAt: this.#now() });
		this.#loading.delete(day);
	}

	async #loadIndex(): Promise<void> {
		this.#indexLoading = true;
		let value: ArchiveIndex | null = null;
		try {
			value = parseIndex(await this.#json('archive/flashes/index.json'));
		} catch { /* no archive yet */ }
		this.#index = { value, fetchedAt: this.#now() };
		this.#indexLoading = false;
	}
}

export interface DayFeedOptions {
	ring: FlashRing;
	days: FlashDays;
	/** Wall clock, UTC ms. */
	now: () => number;
	onError?: (error: unknown) => void;
}

/** Streams archived chunks around the playhead into the ring in event order, like the live feed. */
export class DayFeed {
	readonly #ring: FlashRing;
	readonly #days: FlashDays;
	readonly #now: () => number;
	readonly #onError: (error: unknown) => void;
	readonly #decoded = new Map<string, DecodedChunk>();
	readonly #inFlight = new Map<string, AbortController>();
	readonly #failed = new Map<string, number>();
	/** Chunks pushed since the ring was last cleared, in order. */
	#pushed: ArchiveChunkRef[] = [];
	#pushedFlashes = 0;
	#archivedHours = new Set<number>();
	#stopped = false;

	constructor(options: DayFeedOptions) {
		this.#ring = options.ring;
		this.#days = options.days;
		this.#now = options.now;
		this.#onError = options.onError ?? (() => {});
	}

	update(time: number): void {
		if (this.#stopped || !Number.isFinite(time)) return;
		const days = [-DAY, 0, DAY].map((offset) => utcDay(time + offset));
		this.#days.retain(days);
		const known = days.map((day) => this.#days.day(day));
		if (known[1] === undefined) return;
		const order = known.flatMap((refs) => refs ?? []);
		this.#archivedHours = new Set(order.map((ref) => ref.hour));
		const from = time - KEEP_BEHIND_MS;
		const first = order.findIndex((ref) => ref.eventMax >= from);
		if (first < 0 || order[first].eventMin > time + LOOK_AHEAD_MS) {
			if (this.#pushed.length) this.#reset();
			return;
		}
		let next = this.#next(order, first, from);
		this.#prefetch(order, next);
		while (next < order.length && order[next].eventMin <= time + LOOK_AHEAD_MS) {
			const chunk = this.#decoded.get(order[next].url);
			if (!chunk || !this.#fits(chunk.count, from)) break;
			this.#ring.push(chunk);
			this.#decoded.delete(order[next].url);
			this.#pushed.push(order[next]);
			this.#pushedFlashes += chunk.count;
			next++;
		}
		this.#prefetch(order, next);
	}

	/** Index of the next chunk to push; clears the ring when the playhead left what it holds. */
	#next(order: ArchiveChunkRef[], first: number, from: number): number {
		const last = this.#pushed.at(-1);
		if (!last) return first;
		const index = order.findIndex((ref) => ref.url === last.url);
		const lost = this.#pushedFlashes > this.#ring.size;
		const start = lost && this.#ring.size ? this.#ring.time[this.#ring.slot(0)] : this.#pushed[0].eventMin;
		if (index < 0 || first > index + 1 || (from < start && order[first].eventMin < start)) {
			this.#reset();
			return first;
		}
		return index + 1;
	}

	/** Whether pushing `count` flashes keeps every flash newer than `from`. */
	#fits(count: number, from: number): boolean {
		const excess = this.#ring.size + count - this.#ring.capacity;
		return excess <= 0 || this.#ring.size === 0 || this.#ring.time[this.#ring.slot(Math.min(excess, this.#ring.size) - 1)] < from;
	}

	#prefetch(order: ArchiveChunkRef[], next: number): void {
		const wanted = order.slice(next, next + PREFETCH);
		const urls = new Set(wanted.map((ref) => ref.url));
		for (const [url, request] of this.#inFlight) if (!urls.has(url)) { request.abort(); this.#inFlight.delete(url); }
		for (const url of this.#decoded.keys()) if (!urls.has(url)) this.#decoded.delete(url);
		for (const ref of wanted) {
			if (this.#decoded.has(ref.url) || this.#inFlight.has(ref.url) || (this.#failed.get(ref.url) ?? 0) > this.#now()) continue;
			const request = new AbortController();
			this.#inFlight.set(ref.url, request);
			this.#days.chunk(ref, request.signal)
				.then((chunk) => { if (!request.signal.aborted && !this.#stopped) this.#decoded.set(ref.url, chunk); })
				.catch((error: unknown) => {
					if (request.signal.aborted) return;
					this.#failed.set(ref.url, this.#now() + RETRY_MS);
					this.#days.invalidate(utcDay(ref.hour));
					this.#onError(error);
				})
				.finally(() => { if (this.#inFlight.get(ref.url) === request) this.#inFlight.delete(ref.url); });
		}
	}

	#reset(): void {
		this.#ring.clear();
		this.#pushed = [];
		this.#pushedFlashes = 0;
	}

	/** Whether the ring holds the archive around `time`; false for an hour without archive. */
	covers(time: number): boolean {
		const first = this.#pushed[0];
		const last = this.#pushed.at(-1);
		if (!first || !last || !this.#archivedHours.has(time - (time % HOUR))) return false;
		const lost = this.#pushedFlashes > this.#ring.size;
		const from = lost && this.#ring.size ? this.#ring.time[this.#ring.slot(0)] : first.hour;
		return time >= from && time <= (last.last ? last.hour + HOUR : last.eventMax);
	}

	stop(): void {
		this.#stopped = true;
		for (const request of this.#inFlight.values()) request.abort();
		this.#inFlight.clear();
		this.#decoded.clear();
	}
}
