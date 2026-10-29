import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { SearchError, StormsNearby, StormSummary } from '../contract/types';
import { pathDistanceKm, queryTiles } from './geo';
import { rankNearby } from './nearby';
import { CANDIDATES, EXACT, handleNearby, MAX_CANDIDATES, queryKeys, type SearchDatabase, type SearchStatement, searchNearby } from './search';

const SCHEMA = readFileSync(new URL('../../../data/packages/scintille-pipelines/src/scintille_pipelines/sql/storm_search_schema.sql', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-29T18:00:00Z') / 1000;
const H = 3600;

/** D1 stand-in: SQLite runs the Worker's statements; counts the rows each query returns. */
class FakeD1 implements SearchDatabase {
	readonly db = new DatabaseSync(':memory:');
	queries = 0;
	fail = false;
	constructor() {
		this.db.exec(SCHEMA);
	}
	prepare(sql: string, values: unknown[] = []): SearchStatement {
		return {
			bind: (...next: unknown[]) => this.prepare(sql, next),
			all: async <T,>() => {
				this.queries++;
				if (this.fail) throw new Error('D1_ERROR: daily limit exceeded');
				return { results: this.db.prepare(sql).all(...(values as never[])) as T[] };
			},
		};
	}
	async batch<T>(statements: SearchStatement[]) {
		return Promise.all(statements.map((s) => s.all<T>()));
	}
	meta(values: Record<string, string>) {
		for (const [key, value] of Object.entries(values)) this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value);
	}
	add(slug: string, path: [number, number][], hours: [number, number], changes: Partial<StormSummary> = {}, score = 100, radius = 10) {
		const [start, end] = hours.map((h) => NOW + h * H);
		const summary: StormSummary = {
			storm_id: slug, slug, name: slug, label: slug, country_code: null, t_start: new Date(start * 1000).toISOString(),
			t_end: new Date(end * 1000).toISOString(), closed: true, flashes: 500, peak_rate: 20, level: 4, level_name: 'Intense',
			level_rule: 'levels score=flashes_x_peak count=best_source thresholds=8,25,120,450', sources: ['mtg-li'], distance_km: 0, ...changes,
		};
		const [cLat, cLon, spread] = centroid(path);
		this.db.prepare('INSERT INTO storms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(slug, start, end, 4, score, JSON.stringify(summary), JSON.stringify(path), radius, cLat, cLon, spread, 'd');
		// A superset of the pipeline's tiles: the boxes of the disc that holds the whole storm.
		const tiles = [...queryTiles(cLat, cLon, spread + radius + 10), ...queryTiles(cLat, cLon, 501 + spread + radius)];
		for (let day = Math.floor(start / 86400); day <= Math.floor(end / 86400); day++) {
			for (const tile of tiles) this.db.prepare('INSERT OR IGNORE INTO storm_tiles VALUES (?, ?, ?)').run(day, tile, slug);
		}
	}
}

/** Like the pipeline: spherical mean of the path and the farthest point's distance from it. */
function centroid(path: [number, number][]): [number, number, number] {
	const v = path.map(([lat, lon]) => [lat, lon].map((d) => (d * Math.PI) / 180)).map(([p, l]) => [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)]);
	const [x, y, z] = [0, 1, 2].map((i) => v.reduce((sum, u) => sum + u[i], 0));
	const lat = Math.round(((Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI) * 1000) / 1000;
	const lon = Math.round(((Math.atan2(y, x) * 180) / Math.PI) * 1000) / 1000;
	return [lat, lon, Math.ceil(Math.max(...path.map((p) => pathDistanceKm(lat, lon, [p]))) * 10) / 10];
}

function catalog(): FakeD1 {
	const d1 = new FakeD1();
	d1.meta({ schema: '1', published_at: '2026-10-29T17:24:00Z', last_observation_time: '2026-10-29T17:00:00Z', pending: '0', retention_days: '58' });
	d1.add('lyon-yesterday', [[45.9, 4.9], [46.1, 5.3]], [-26, -24]);
	d1.add('alps-ongoing', [[45.9, 6.9]], [-1, 0], {}, 30);
	d1.add('lyon-last-week', [[45.8, 4.8]], [-170, -168]);
	d1.add('adriatic', [[42.5, 15.5]], [-60, -58], {}, 400);
	d1.add('fiji', [[-17.7, 179.6], [-17.6, -179.7]], [-5, -3]);
	return d1;
}

const nearby = async (d1: SearchDatabase, query: string, now = NOW) => {
	const response = await handleNearby(new URL(`https://scintille.app/api/storms/nearby?${query}`), d1, now, 'test');
	return { status: response.status, headers: response.headers, body: await response.json() as StormsNearby & SearchError };
};

describe('nearby search', () => {
	it('answers with ranked published summaries, the query as answered and the catalog state', async () => {
		const { status, headers, body } = await nearby(catalog(), 'lat=45.764&lon=4.836');
		expect(status).toBe(200);
		expect(headers.get('Cache-Control')).toBe('public, max-age=60');
		expect(body.query).toEqual({ lat: 45.8, lon: 4.8, hours: 72, km: 200, limit: 4, window_start: '2026-10-26T18:00:00Z', window_end: '2026-10-29T18:00:00Z' });
		expect(body.storms.map((s) => [s.storm.slug, s.distance_km])).toEqual([['lyon-yesterday', 0], ['alps-ongoing', 150]]);
		expect(body.total).toBe(2);
		expect(body.catalog).toMatchObject({ min_level: 3, stale: false, complete: true, retention_days: 58 });
		expect(body.storms[0].storm.level_name).toBe('Intense');
	});

	it('widens only when asked, and the wide grid finds a storm 600 km away', async () => {
		const d1 = catalog();
		expect((await nearby(d1, 'lat=45.8&lon=4.8&km=500')).body.storms.map((s) => s.storm.slug)).not.toContain('adriatic');
		const wide = await nearby(d1, 'lat=45.8&lon=4.8&km=3000&hours=168&limit=8');
		expect(wide.body.storms.map((s) => s.storm.slug)).toEqual(expect.arrayContaining(['adriatic', 'lyon-last-week']));
		expect(wide.body.storms.find((s) => s.storm.slug === 'adriatic')?.distance_km).toBeGreaterThan(800);
	});

	it('finds storms across the date line', async () => {
		const { body } = await nearby(catalog(), 'lat=-17.7&lon=-179.9&km=50');
		expect(body.storms.map((s) => s.storm.slug)).toEqual(['fiji']);
	});

	it('tells an empty answer from a missing, stale or partial index', async () => {
		const empty = await nearby(catalog(), 'lat=-33.9&lon=18.4');
		expect(empty.status).toBe(200);
		expect(empty.body.storms).toEqual([]);
		const stale = catalog();
		stale.meta({ last_observation_time: '2026-10-29T13:00:00Z', pending: '120' });
		expect((await nearby(stale, 'lat=45.8&lon=4.8')).body.catalog).toMatchObject({ stale: true, complete: false });
		const missing = await nearby(new FakeD1(), 'lat=45.8&lon=4.8');
		expect([missing.status, missing.body.status]).toEqual([503, 'unavailable']);
	});

	it('refuses invalid input and reports D1 failures without inventing storms', async () => {
		const invalid = await nearby(catalog(), 'lat=45.8&lon=4.8&km=5000');
		expect([invalid.status, invalid.body.status, invalid.headers.get('Cache-Control')]).toEqual([400, 'invalid', 'no-store']);
		const failing = catalog();
		failing.fail = true;
		const down = await nearby(failing, 'lat=45.8&lon=4.8');
		expect([down.status, down.body.status]).toEqual([503, 'unavailable']);
		const unconfigured = await handleNearby(new URL('https://scintille.app/api/storms/nearby?lat=1&lon=1'), undefined, NOW, 'test');
		expect(unconfigured.status).toBe(503);
	});

	it('refuses an answer that would read too many candidates', async () => {
		const d1 = catalog();
		for (let i = 0; i <= MAX_CANDIDATES; i++) d1.add(`swarm-${i}`, [[0.5, 10.5]], [-2, -1]);
		const { status, body } = await nearby(d1, 'lat=0.5&lon=10.5&km=100');
		expect([status, body.status]).toEqual([422, 'too-broad']);
	});

	it('serves repeated queries from the edge cache, keyed by the rounded query and the version', async () => {
		const d1 = catalog();
		const store = new Map<string, Response>();
		const cache = {
			match: async (request: Request) => store.get(request.url)?.clone(),
			put: async (request: Request, response: Response) => void store.set(request.url, response),
		} as unknown as Cache;
		const ask = (q: string, version = 'a') => handleNearby(new URL(`https://scintille.app/api/storms/nearby?${q}`), d1, NOW, version, cache);
		await ask('lat=45.76&lon=4.84');
		const queries = d1.queries;
		expect((await ask('lat=45.78&lon=4.81&hours=72')).status).toBe(200);
		expect(d1.queries).toBe(queries);
		await ask('lat=45.78&lon=4.81', 'b');
		expect(d1.queries).toBeGreaterThan(queries);
		expect([...store.keys()].every((key) => key.includes('lat=45.8&lon=4.8'))).toBe(true);
	});

	it('reads one key per day and tile of the window', () => {
		const keys = queryKeys({ lat: 45.8, lon: 4.8, hours: 72, km: 200, limit: 4 }, NOW);
		expect(new Set(keys.map(([day]) => day)).size).toBe(4);
		expect(keys.length).toBeLessThan(80);
	});

	it('seeks the primary keys instead of scanning tables', () => {
		const db = new FakeD1().db;
		const plan = (sql: string, ...values: unknown[]) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(values as never[])).map((row) => String((row as { detail: string }).detail));
		const candidates = plan(CANDIDATES, '[[1,2]]', 0, 0, 10, 45, 5, 200);
		expect(candidates).toEqual(expect.arrayContaining(['SEARCH t USING PRIMARY KEY (day=? AND tile=?)', 'SEARCH s USING PRIMARY KEY (slug=?)']));
		expect(plan(EXACT, '[]')).toContain('SEARCH storms USING PRIMARY KEY (slug=?)');
		expect([...candidates, ...plan(EXACT, '[]')].some((step) => /^SCAN (t|s|storms|storm_tiles)\b/.test(step))).toBe(false);
	});

	it('reads paths only for storms near the edge or that may rank, and still counts the others', async () => {
		const d1 = catalog();
		const cluster = Array.from({ length: 300 }, (_, i) => ({
			slug: `cluster-${i}`, t_start: NOW - 30 * H, t_end: NOW - 29 * H, score: 30 + i, radius_km: 10,
			path: [[0.5 + (i % 10) * 0.02, 10.5 + Math.floor(i / 10) * 0.02]] as [number, number][],
		}));
		for (const storm of cluster) d1.add(storm.slug, storm.path, [-30, -29], {}, storm.score);
		let read = 0;
		const prepare = d1.prepare.bind(d1);
		d1.prepare = (sql: string, values: unknown[] = []) => {
			const statement = prepare(sql, values);
			return sql === EXACT && values.length ? { ...statement, all: async <T,>() => {
				const out = await statement.all<T>();
				read += out.results.length;
				return out;
			} } : statement;
		};
		const { body } = await nearby(d1, 'lat=0.5&lon=10.5&km=200&limit=4');
		expect(body.total).toBe(300);
		const expected = rankNearby(cluster, { lat: 0.5, lon: 10.5, hours: 72, km: 200, limit: 4 }, NOW).slice(0, 4);
		expect(body.storms.map((s) => s.storm.slug)).toEqual(expected.map((m) => m.candidate.slug));
		expect(read).toBeLessThan(30);
	});

	it('ranks exactly like reading every path', async () => {
		let seed = 288;
		const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		const d1 = new FakeD1();
		d1.meta({ published_at: '2026-10-29T17:24:00Z', last_observation_time: '2026-10-29T17:00:00Z', pending: '0' });
		const all: { slug: string; t_start: number; t_end: number; score: number; radius_km: number; path: [number, number][] }[] = [];
		for (let i = 0; i < 400; i++) {
			let [lat, lon] = [44 + random() * 4, 3 + random() * 6];
			const path: [number, number][] = [[lat, lon]];
			for (let k = Math.floor(random() * 6); k > 0; k--) path.push([(lat += (random() - 0.5) * 1.2), (lon += (random() - 0.5) * 1.6)]);
			const end = -Math.floor(random() * 70);
			const score = 25 + Math.floor(random() * 500);
			const radius = Math.round(random() * 400) / 10;
			d1.add(`s-${i}`, path, [end - 2, end], {}, score, radius);
			all.push({ slug: `s-${i}`, t_start: NOW + (end - 2) * H, t_end: NOW + end * H, score, radius_km: radius, path });
		}
		for (const [km, limit] of [[50, 4], [120, 8], [200, 1], [400, 4]]) {
			const q = { lat: 45.8, lon: 4.8, hours: 72, km, limit };
			const expected = rankNearby(all, q, NOW);
			const body = (await (await searchNearby(d1, q, NOW)).json()) as StormsNearby;
			expect(body.storms.map((s) => s.storm.slug)).toEqual(expected.slice(0, limit).map((m) => m.candidate.slug));
			expect(body.total).toBe(expected.length);
		}
	});

	it('answers from the bounded index without reading the whole catalog', async () => {
		const d1 = catalog();
		for (let i = 0; i < 2000; i++) d1.add(`elsewhere-${i}`, [[-10 + (i % 20), 120 + (i % 30)]], [-30, -29]);
		const response = await searchNearby(d1, { lat: 45.8, lon: 4.8, hours: 72, km: 200, limit: 4 }, NOW);
		expect(((await response.json()) as StormsNearby).total).toBe(2);
	});
});
