import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { SearchError, StormsNearby, StormSummary } from '../contract/types';
import { GRIDS, tileOf } from './geo';
import { CANDIDATES, handleNearby, MAX_CANDIDATES, queryKeys, type SearchDatabase, type SearchStatement, searchNearby, SUMMARIES } from './search';

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
	add(slug: string, path: [number, number][], hours: [number, number], changes: Partial<StormSummary> = {}, score = 100) {
		const [start, end] = hours.map((h) => NOW + h * H);
		const summary: StormSummary = {
			storm_id: slug, slug, name: slug, label: slug, country_code: null, t_start: new Date(start * 1000).toISOString(),
			t_end: new Date(end * 1000).toISOString(), closed: true, flashes: 500, peak_rate: 20, level: 4, level_name: 'Intense',
			level_rule: 'levels score=flashes_x_peak count=best_source thresholds=8,25,120,450', sources: ['mtg-li'], distance_km: 0, ...changes,
		};
		this.db.prepare('INSERT INTO storms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(slug, start, end, 4, score, JSON.stringify(summary), JSON.stringify(path), 10, 'd');
		for (let day = Math.floor(start / 86400); day <= Math.floor(end / 86400); day++) {
			for (const [lat, lon] of path) {
				for (const grid of [GRIDS.fine, GRIDS.coarse]) this.db.prepare('INSERT OR IGNORE INTO storm_tiles VALUES (?, ?, ?)').run(day, tileOf(lat, lon, grid), slug);
			}
		}
	}
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
		expect(plan(CANDIDATES, '[[1,2]]', 0, 0, 10)).toEqual(expect.arrayContaining(['SEARCH t USING PRIMARY KEY (day=? AND tile=?)', 'SEARCH s USING PRIMARY KEY (slug=?)']));
		expect(plan(SUMMARIES, '[]')).toContain('SEARCH storms USING PRIMARY KEY (slug=?)');
		expect([...plan(CANDIDATES, '[]', 0, 0, 1), ...plan(SUMMARIES, '[]')].some((step) => /^SCAN (t|s|storms|storm_tiles)\b/.test(step))).toBe(false);
	});

	it('answers from the bounded index without reading the whole catalog', async () => {
		const d1 = catalog();
		for (let i = 0; i < 2000; i++) d1.add(`elsewhere-${i}`, [[-10 + (i % 20), 120 + (i % 30)]], [-30, -29]);
		const response = await searchNearby(d1, { lat: 45.8, lon: 4.8, hours: 72, km: 200, limit: 4 }, NOW);
		expect(((await response.json()) as StormsNearby).total).toBe(2);
	});
});
