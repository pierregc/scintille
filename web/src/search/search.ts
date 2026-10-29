/** GET /api/storms/nearby against the D1 search index (ADR 0027). */
import { SCHEMA_VERSION, type SearchError, type StormSummary, type StormsNearby } from '../contract/types';
import { queryTiles } from './geo';
import { type Candidate, nearbyKey, type NearbyQuery, parseNearbyQuery, rankNearby, STALE_AFTER_MS } from './nearby';

/** The subset of a D1 binding the search uses. */
export interface SearchStatement {
	bind(...values: unknown[]): SearchStatement;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface SearchDatabase {
	prepare(sql: string): SearchStatement;
	batch<T = Record<string, unknown>>(statements: SearchStatement[]): Promise<{ results: T[] }[]>;
}

/** More candidates than this in one answer means the area or window is too broad. */
export const MAX_CANDIDATES = 4000;
export const PUBLISHED_MIN_LEVEL = 3;
const DAY = 86_400;

export const CANDIDATES = `WITH q(day, tile) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))
SELECT DISTINCT s.slug, s.t_start, s.t_end, s.score, s.path, s.radius_km
FROM q CROSS JOIN storm_tiles t CROSS JOIN storms s
WHERE t.day = q.day AND t.tile = q.tile AND s.slug = t.slug AND s.t_end >= ?2 AND s.t_start <= ?3
LIMIT ?4`;
const META = 'SELECT key, value FROM meta';
export const SUMMARIES = 'SELECT slug, summary FROM storms WHERE slug IN (SELECT value FROM json_each(?1))';

interface Row { slug: string; t_start: number; t_end: number; score: number; path: string; radius_km: number }

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

export async function searchNearby(db: SearchDatabase, q: NearbyQuery, nowSeconds: number): Promise<Response> {
	const from = nowSeconds - q.hours * 3600;
	const [candidates, meta] = await db.batch([
		db.prepare(CANDIDATES).bind(JSON.stringify(queryKeys(q, nowSeconds)), from, nowSeconds, MAX_CANDIDATES + 1),
		db.prepare(META),
	]);
	const info = Object.fromEntries((meta.results as { key: string; value: string }[]).map(({ key, value }) => [key, value]));
	if (!info.published_at) return failure(503, 'unavailable', ['The search index is not ready.']);
	const rows = candidates.results as unknown as Row[];
	if (rows.length > MAX_CANDIDATES) return failure(422, 'too-broad', ['Too many storms in this area and window: narrow the radius or the window.']);
	const matches = rankNearby(rows.map((row): Candidate => ({ ...row, path: JSON.parse(row.path) as [number, number][] })), q, nowSeconds);
	const chosen = matches.slice(0, q.limit);
	const summaries = new Map<string, StormSummary>();
	if (chosen.length) {
		const { results } = await db.prepare(SUMMARIES).bind(JSON.stringify(chosen.map((m) => m.candidate.slug))).all<{ slug: string; summary: string }>();
		for (const { slug, summary } of results) summaries.set(slug, JSON.parse(summary) as StormSummary);
	}
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
		total: matches.length,
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
