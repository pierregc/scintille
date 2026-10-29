import { type ActiveCell, type ActiveStorms, END_REASON_VALUES, type EndedStorm, SOURCE_VALUES } from '../../contract/types';
import { boundedBody } from '../clouds/response';
import { type Backoff, backoffDelay, DEFAULT_BACKOFF, documentVisibility, type Visibility } from '../live/client';
import { CONTRACT_MAJOR } from '../live/decode';

/** ADR 0021: clients poll every 60 s while the live globe is open, revalidating with the cached ETag. */
export const ACTIVE_POLL_MS = 60_000;
/** Three missed updates (ADR 0021 stale alarm). */
export const ACTIVE_STALE_MS = 900_000;
const MAX_BYTES = 2 << 20;

/** ADR 0009 level names. */
export const LEVEL_NAMES = ['Light', 'Moderate', 'Strong', 'Intense', 'Exceptional'];

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function validCell(cell: unknown): cell is ActiveCell {
	if (!record(cell) || typeof cell.id !== 'string' || !cell.id || !finite(cell.lat) || !finite(cell.lon) ||
		Math.abs(cell.lat) > 90 || !Number.isSafeInteger(cell.level) || !finite(cell.area_km2) ||
		!time(cell.t_start) || !time(cell.t_end) || !strings(cell.previous_ids) || !strings(cell.merged) ||
		!Array.isArray(cell.sources) || !cell.sources.every((s) => SOURCE_VALUES.includes(s as never)) ||
		(cell.name !== null && typeof cell.name !== 'string') || (cell.slug !== null && typeof cell.slug !== 'string') ||
		(cell.split_from !== null && typeof cell.split_from !== 'string') || !record(cell.bounds) ||
		![cell.bounds.west, cell.bounds.south, cell.bounds.east, cell.bounds.north].every(finite)) return false;
	if (!Array.isArray(cell.hull) || !cell.hull.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite))) return false;
	return Array.isArray(cell.path) && cell.path.every((p) => record(p) && time(p.time) && finite(p.lat) && finite(p.lon));
}

function validEnded(entry: unknown): entry is EndedStorm {
	return record(entry) && typeof entry.id === 'string' && END_REASON_VALUES.includes(entry.reason as never) &&
		(entry.into === null || typeof entry.into === 'string') && time(entry.t_end) && time(entry.ended_at);
}

/** Checks the envelope and drops malformed cells; the service validates the full contract. */
export function parseActiveStorms(value: unknown): ActiveStorms {
	if (!record(value) || Number(String(value.schema_version).split('.')[0]) !== CONTRACT_MAJOR ||
		!time(value.published_at) || !Array.isArray(value.cells) || !Array.isArray(value.ended) || !Array.isArray(value.sources)) {
		throw new Error('invalid active storms');
	}
	return {
		...(value as unknown as ActiveStorms),
		cells: value.cells.filter(validCell),
		ended: value.ended.filter(validEnded),
		sources: value.sources.filter((s) => record(s) && SOURCE_VALUES.includes(s.source as never)) as ActiveStorms['sources'],
	};
}

export type CellEnd = 'expired' | 'source-gap' | 'lost';

/** Where a followed storm id stands in a snapshot. */
export interface CellResolution {
	cell: ActiveCell | null;
	/** Set when the storm continues under another id. */
	via: 'merged' | 'replaced' | null;
	/** Set when no cell continues it; lost means the snapshot no longer mentions it. */
	end: { reason: CellEnd; tEnd: number | null } | null;
}

/** Follows `id` through previous ids, merges and replacements to the cell that continues it. */
export function resolveCell(snapshot: Pick<ActiveStorms, 'cells' | 'ended'>, id: string): CellResolution {
	const seen = new Set<string>();
	let current = id;
	let via: CellResolution['via'] = null;
	while (!seen.has(current)) {
		seen.add(current);
		const cell = snapshot.cells.find((c) => c.id === current) ?? snapshot.cells.find((c) => c.previous_ids.includes(current));
		if (cell) return { cell, via: cell.id === id ? null : (via ?? 'replaced'), end: null };
		const ended = snapshot.ended.find((e) => e.id === current);
		if (!ended) break;
		if ((ended.reason === 'merged' || ended.reason === 'replaced') && ended.into) {
			via = ended.reason === 'merged' ? 'merged' : (via ?? 'replaced');
			current = ended.into;
			continue;
		}
		const reason = ended.reason === 'source-gap' ? 'source-gap' : 'expired';
		return { cell: null, via, end: { reason, tEnd: Date.parse(ended.t_end) } };
	}
	return { cell: null, via, end: { reason: 'lost', tEnd: null } };
}

const KM_PER_DEG = 111.2;

/** Whether (lon, lat) lies inside a closed [lon, lat] ring, in plate carrée around the ring. */
export function insideRing(ring: readonly number[][], lon: number, lat: number): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Distance in km from (lat, lon) to a cell: 0 inside its hull, else to its nearest hull edge or centroid. */
export function cellDistanceKm(cell: Pick<ActiveCell, 'lat' | 'lon' | 'hull'>, lat: number, lon: number): number {
	const near = cell.lon + ((((lon - cell.lon) % 360) + 540) % 360) - 180;
	if (cell.hull.length >= 4 && insideRing(cell.hull, near, lat)) return 0;
	const scale = Math.cos((lat * Math.PI) / 180);
	const xy = ([x, y]: readonly number[]) => [(x - near) * scale * KM_PER_DEG, (y - lat) * KM_PER_DEG];
	let best = Math.hypot(...xy([cell.lon, cell.lat]));
	for (let i = 1; i < cell.hull.length; i++) {
		const [ax, ay] = xy(cell.hull[i - 1]);
		const [bx, by] = xy(cell.hull[i]);
		const dx = bx - ax;
		const dy = by - ay;
		const t = Math.min(Math.max(-(ax * dx + ay * dy) / (dx * dx + dy * dy || 1), 0), 1);
		best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
	}
	return best;
}

/** The cell under (lat, lon), or the nearest one within `radiusKm`; overlapping hulls go to the nearest centroid. */
export function pickCell(cells: readonly ActiveCell[], lat: number, lon: number, radiusKm: number): ActiveCell | null {
	let best: { cell: ActiveCell; distance: number; centre: number } | null = null;
	for (const cell of cells) {
		const distance = cellDistanceKm(cell, lat, lon);
		if (distance > radiusKm) continue;
		const centre = cellDistanceKm({ lat: cell.lat, lon: cell.lon, hull: [] }, lat, lon);
		if (!best || distance < best.distance || (distance === best.distance && centre < best.centre)) best = { cell, distance, centre };
	}
	return best?.cell ?? null;
}

export interface ActiveFeedOptions {
	/** Data root; the snapshot is at `<baseUrl>/storms/active.json`. Must be absolute. */
	baseUrl: string;
	pollIntervalMs?: number;
	backoff?: Backoff;
	fetch?: typeof fetch;
	visibility?: Visibility;
	random?: () => number;
	/** Wall clock, UTC ms. */
	now: () => number;
	onSnapshot?: (snapshot: ActiveStorms) => void;
	onError?: (error: unknown) => void;
}

/** Polls storms/active.json while started; keeps the last good snapshot through failures. */
export class ActiveFeed {
	readonly url: URL;
	readonly #pollIntervalMs: number;
	readonly #backoff: Backoff;
	readonly #fetch: typeof fetch;
	readonly #visibility: Visibility;
	readonly #random: () => number;
	readonly #now: () => number;
	readonly #onSnapshot: (snapshot: ActiveStorms) => void;
	readonly #onError: (error: unknown) => void;
	#snapshot: ActiveStorms | null = null;
	#loadedAt: number | null = null;
	#failures = 0;
	#running = false;
	#polling = false;
	#revision = 0;
	#inFlight: Promise<void> | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#abort: AbortController | undefined;
	#unsubscribe: (() => void) | undefined;

	constructor(options: ActiveFeedOptions) {
		const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
		this.url = new URL('storms/active.json', base);
		this.#pollIntervalMs = options.pollIntervalMs ?? ACTIVE_POLL_MS;
		this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#visibility = options.visibility ?? documentVisibility;
		this.#random = options.random ?? Math.random;
		this.#now = options.now;
		this.#onSnapshot = options.onSnapshot ?? (() => {});
		this.#onError = options.onError ?? (() => {});
	}

	/** Latest snapshot read, or null; cleared on stop. */
	get snapshot(): ActiveStorms | null { return this.#snapshot; }
	/** When the latest snapshot was read (UTC ms), or null. */
	get loadedAt(): number | null { return this.#loadedAt; }
	get failures(): number { return this.#failures; }
	get running(): boolean { return this.#running; }

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#abort = new AbortController();
		this.#unsubscribe = this.#visibility.subscribe(() => this.#onVisibilityChange());
		if (!this.#visibility.hidden()) {
			if (this.#polling) void this.idle().then(() => this.poll());
			else void this.poll();
		}
	}

	stop(): void {
		this.#revision++;
		this.#running = false;
		this.#snapshot = null;
		this.#loadedAt = null;
		this.#failures = 0;
		this.#unsubscribe?.();
		this.#abort?.abort();
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	idle(): Promise<void> { return this.#inFlight ?? Promise.resolve(); }

	poll(): Promise<void> {
		if (this.#polling || !this.#running) return Promise.resolve();
		this.#inFlight = this.#poll();
		return this.#inFlight;
	}

	async #poll(): Promise<void> {
		const revision = this.#revision;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#polling = true;
		try {
			const response = await this.#fetch(this.url.href, { signal: this.#abort?.signal, cache: 'no-cache' });
			if (!response.ok) throw new Error(`${this.url.href}: HTTP ${response.status}`);
			const snapshot = parseActiveStorms(JSON.parse(new TextDecoder().decode(await boundedBody(response, MAX_BYTES))));
			if (!this.#running || revision !== this.#revision) return;
			this.#failures = 0;
			this.#loadedAt = this.#now();
			if (snapshot.published_at === this.#snapshot?.published_at) return;
			this.#snapshot = snapshot;
			this.#onSnapshot(snapshot);
		} catch (error) {
			if (!this.#running || revision !== this.#revision) return;
			this.#failures++;
			this.#onError(error);
		} finally {
			this.#polling = false;
			if (revision === this.#revision) this.#schedule();
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
		const delay = this.#failures === 0 ? this.#pollIntervalMs : backoffDelay(this.#failures, this.#backoff, this.#random);
		this.#timer = setTimeout(() => void this.poll(), delay);
	}
}
