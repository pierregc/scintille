/** GET /api/storms/nearby against the D1 search index (ADR 0027). */
import { SCHEMA_VERSION, type SearchError, type StormSummary, type StormsNearby } from '../contract/types';
import { queryTiles } from './geo';
import { type Candidate, nearbyKey, type NearbyQuery, parseNearbyQuery, rankNearby, rankOf, STALE_AFTER_MS } from './nearby';

/** The subset of a D1 binding the search uses. */
export interface SearchStatement {
	bind(...values: unknown[]): SearchStatement;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface SearchDatabase {
	prepare(sql: string): SearchStatement;
	batch<T = Record<string, unknown>>(statements: SearchStatement[]): Promise<{ results: T[] }[]>;
}

/** More storms than this within reach of the disc means the area or window is too broad. */
export const MAX_CANDIDATES = 4000;
/** Paths read exactly in one answer: the possible top storms and those near the edge. */
export const MAX_EXACT = 400;
export const PUBLISHED_MIN_LEVEL = 3;
const DAY = 86_400;
/** Covers the law of cosines' rounding near small distances. */
const SLACK_KM = 1;

/** Storms of the window in the query's tiles whose centroid bound can reach the disc, without paths. */
export const CANDIDATES = `WITH q(day, tile) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1)),
c AS (
SELECT DISTINCT s.slug, s.t_end, s.score, s.radius_km, s.spread_km,
6371 * acos(min(1, max(-1, sin(radians(?5)) * sin(radians(s.c_lat)) + cos(radians(?5)) * cos(radians(s.c_lat)) * cos(radians(s.c_lon - ?6))))) AS d_c
FROM q CROSS JOIN storm_tiles t CROSS JOIN storms s
WHERE t.day = q.day AND t.tile = q.tile AND s.slug = t.slug AND s.t_end >= ?2 AND s.t_start <= ?3)
SELECT * FROM c WHERE d_c - spread_km - radius_km <= ?7 + ${SLACK_KM} LIMIT ?4`;
const META = 'SELECT key, value FROM meta';
export const EXACT = 'SELECT slug, path, summary FROM storms WHERE slug IN (SELECT value FROM json_each(?1))';

interface Row { slug: string; t_end: number; score: number; radius_km: number; spread_km: number; d_c: number }
interface Bounded extends Row { low: number; high: number; certain: boolean }

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

export const PUBLIC_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' };
const ERROR_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function failure(status: number, kind: SearchError['status'], errors: string[]): Response {
	const body: SearchError = { schema_version: SCHEMA_VERSION, status: kind, errors };
	return new Response(JSON.stringify(body), { status, headers: ERROR_HEADERS });
}

/** Day and tile pairs a query reads. */
export function queryKeys(q: NearbyQuery, nowSeconds: number): [number, number][] {
	const tiles = queryTiles(q.lat, q.lon, q.km);
	const keys: [number, number][] = [];
	for (let day = Math.floor((nowSeconds - q.hours * 3600) / DAY); day <= Math.floor(nowSeconds / DAY); day++) {
		for (const tile of tiles) keys.push([day, tile]);
	}
	return keys;
}

/**
 * Storms whose path must be read: every storm that may lie outside the disc, and every certain one
 * that may rank in the top `limit`. The others are certainly in and certainly below it.
 */
export function needsPath(rows: readonly Row[], q: NearbyQuery, nowSeconds: number): { bounded: Bounded[]; needed: Bounded[] } {
	const bounded = rows.map((row): Bounded => {
		const low = Math.max(0, row.d_c - row.spread_km - row.radius_km - SLACK_KM);
		const high = Math.max(0, row.d_c + row.spread_km - row.radius_km + SLACK_KM);
		return { ...row, low, high, certain: high <= q.km };
	}).filter((row) => row.low <= q.km);
	const age = (row: Row) => Math.max(0, nowSeconds - row.t_end) / 3600;
	const floors = bounded.filter((row) => row.certain).map((row) => rankOf(row.score, age(row), row.high)).sort((a, b) => b - a);
	const floor = floors.length >= q.limit ? floors[q.limit - 1] : -Infinity;
	return { bounded, needed: bounded.filter((row) => !row.certain || rankOf(row.score, age(row), row.low) >= floor) };
}

export async function searchNearby(db: SearchDatabase, q: NearbyQuery, nowSeconds: number): Promise<Response> {
	const from = nowSeconds - q.hours * 3600;
	const [candidates, meta] = await db.batch([
		db.prepare(CANDIDATES).bind(JSON.stringify(queryKeys(q, nowSeconds)), from, nowSeconds, MAX_CANDIDATES + 1, q.lat, q.lon, q.km),
		db.prepare(META),
	]);
	const info = Object.fromEntries((meta.results as { key: string; value: string }[]).map(({ key, value }) => [key, value]));
	if (!info.published_at) return failure(503, 'unavailable', ['The search index is not ready.']);
	const rows = candidates.results as unknown as Row[];
	const tooBroad = () => failure(422, 'too-broad', ['Too many storms in this area and window: narrow the radius or the window.']);
	if (rows.length > MAX_CANDIDATES) return tooBroad();
	const { bounded, needed } = needsPath(rows, q, nowSeconds);
	if (needed.length > MAX_EXACT) return tooBroad();
	const exact = new Map<string, { path: [number, number][]; summary: string }>();
	if (needed.length) {
		const { results } = await db.prepare(EXACT).bind(JSON.stringify(needed.map((row) => row.slug))).all<{ slug: string; path: string; summary: string }>();
		for (const { slug, path, summary } of results) exact.set(slug, { path: JSON.parse(path) as [number, number][], summary });
	}
	const read = needed.flatMap((row): (Candidate & { summary: string })[] => {
		const found = exact.get(row.slug);
		return found ? [{ slug: row.slug, t_start: 0, t_end: row.t_end, score: row.score, radius_km: row.radius_km, path: found.path, summary: found.summary }] : [];
	});
	const matches = rankNearby(read, q, nowSeconds);
	const unread = bounded.filter((row) => row.certain && !exact.has(row.slug)).length;
	const chosen = matches.slice(0, q.limit);
	const summaries = new Map(chosen.map((m) => [m.candidate.slug, JSON.parse(m.candidate.summary) as StormSummary]));
	const last = info.last_observation_time || null;
	const body: StormsNearby = {
		schema_version: SCHEMA_VERSION,
		query: { ...q, window_start: iso(from), window_end: iso(nowSeconds) },
		catalog: {
			min_level: PUBLISHED_MIN_LEVEL,
			retention_days: Number(info.retention_days) || 58,
			published_at: info.published_at,
			last_observation_time: last,
			stale: last === null || nowSeconds * 1000 - Date.parse(last) > STALE_AFTER_MS,
			complete: info.pending === '0',
		},
		distance: 'path-minus-radius',
		total: matches.length + unread,
		storms: chosen.flatMap((m) => {
			const storm = summaries.get(m.candidate.slug);
			return storm ? [{ storm, distance_km: m.distance_km, score: m.candidate.score }] : [];
		}),
	};
	return new Response(JSON.stringify(body), { headers: PUBLIC_HEADERS });
}

/** Handles a request: validation, the edge cache and D1 failures. */
export async function handleNearby(url: URL, db: SearchDatabase | undefined, nowSeconds: number, version: string, cache?: Cache): Promise<Response> {
	const parsed = parseNearbyQuery(url.searchParams);
	if (!parsed.ok) return failure(400, 'invalid', parsed.errors);
	if (!db) return failure(503, 'unavailable', ['Search is not configured.']);
	const key = new Request(`${url.origin}/api/storms/nearby?${nearbyKey(parsed.value)}&v=${encodeURIComponent(version)}`);
	const cached = await cache?.match(key);
	if (cached) return cached;
	let response: Response;
	try {
		response = await searchNearby(db, parsed.value, nowSeconds);
	} catch {
		return failure(503, 'unavailable', ['Search is unavailable for now.']);
	}
	if (response.ok && cache) {
		const stored = new Response(response.clone().body, { headers: { ...PUBLIC_HEADERS, 'Cache-Control': 'public, max-age=300' } });
		await cache.put(key, stored).catch(() => undefined);
	}
	return response;
}
