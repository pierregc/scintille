import { describe, expect, it } from 'vitest';
import s0 from '../../../../fixtures/storms/active/0.json';
import s1 from '../../../../fixtures/storms/active/1.json';
import s2 from '../../../../fixtures/storms/active/2.json';
import s3 from '../../../../fixtures/storms/active/3.json';
import s4 from '../../../../fixtures/storms/active/4.json';
import type { ActiveCell, ActiveStorms } from '../../contract/types';
import { FakeVisibility } from '../live/testing';
import { ActiveFeed, cellDistanceKm, insideRing, parseActiveStorms, pickCell, resolveCell } from './active';

const snapshots = [s0, s1, s2, s3, s4].map((s) => parseActiveStorms(s));

function cell(id: string, lat: number, lon: number, halfDeg: number, extra: Partial<ActiveCell> = {}): ActiveCell {
	const ring = [[lon - halfDeg, lat - halfDeg], [lon + halfDeg, lat - halfDeg], [lon + halfDeg, lat + halfDeg], [lon - halfDeg, lat + halfDeg], [lon - halfDeg, lat - halfDeg]];
	return {
		id, provisional: false, previous_ids: [], slug: null, name: null, level: 3, flashes: 100,
		t_start: '2026-07-15T18:00:00Z', t_end: '2026-07-15T18:20:00Z', lat, lon,
		bounds: { west: lon - halfDeg, south: lat - halfDeg, east: lon + halfDeg, north: lat + halfDeg },
		area_km2: 1000, hull: ring, sources: ['glm-east'], split_from: null, merged: [], path: [], ...extra,
	};
}

describe('active storms snapshot', () => {
	it('parses the contract fixtures and drops malformed cells', () => {
		expect(snapshots[0].cells.map((c) => c.id)).toContain('synthetic-tampa');
		const broken = parseActiveStorms({ ...s0, cells: [...s0.cells, { id: 'x', lat: 'north' }] });
		expect(broken.cells).toHaveLength(s0.cells.length);
		expect(() => parseActiveStorms({ ...s0, schema_version: '3.0.0' })).toThrow();
		expect(() => parseActiveStorms({ ...s0, cells: null })).toThrow();
	});
});

describe('following an id through snapshots', () => {
	it('keeps the id of a storm that continues, including the main branch of a split', () => {
		for (const snapshot of snapshots) expect(resolveCell(snapshot, 'synthetic-tampa')).toMatchObject({ cell: { id: 'synthetic-tampa' }, via: null, end: null });
		expect(snapshots[1].cells.find((c) => c.split_from === 'synthetic-tampa')?.id).toBe('synthetic-tampa-split');
	});

	it('moves to the new id of a replaced provisional storm', () => {
		expect(resolveCell(snapshots[1], 'synthetic-bangui-1812')).toMatchObject({ cell: { id: 'synthetic-bangui-1803' }, via: 'replaced', end: null });
		expect(resolveCell(snapshots[3], 'synthetic-bangui-1812')).toMatchObject({ cell: { id: 'synthetic-bangui-1803' }, via: 'replaced' });
	});

	it('moves to the storm a merged one continues into', () => {
		expect(resolveCell(snapshots[2], 'synthetic-lakeland')).toMatchObject({ cell: { id: 'synthetic-tampa' }, via: 'merged', end: null });
	});

	it('reports expiry, a silent source and a storm the snapshot no longer lists', () => {
		expect(resolveCell(snapshots[3], 'synthetic-gulf-1808')).toEqual({ cell: null, via: null, end: { reason: 'expired', tEnd: Date.parse('2026-07-15T18:41:02Z') } });
		expect(resolveCell(snapshots[4], 'synthetic-lagos')).toMatchObject({ cell: null, end: { reason: 'source-gap' } });
		expect(resolveCell(snapshots[4], 'synthetic-bangui-1812')).toMatchObject({ cell: null, via: 'replaced', end: { reason: 'source-gap' } });
		expect(resolveCell(snapshots[4], 'unknown')).toEqual({ cell: null, via: null, end: { reason: 'lost', tEnd: null } });
	});

	it('stops on cycles instead of looping', () => {
		const ended = (id: string, into: string) => ({ id, reason: 'replaced' as const, into, t_end: '2026-07-15T18:00:00Z', ended_at: '2026-07-15T18:05:00Z' });
		expect(resolveCell({ cells: [], ended: [ended('a', 'b'), ended('b', 'a')] }, 'a').end?.reason).toBe('lost');
	});
});

describe('picking a cell', () => {
	const a = cell('a', 10, 20, 0.5, { level: 2 });
	const b = cell('b', 10, 21.5, 0.5, { level: 4 });

	it('selects the cell under the point, else the nearest one within the radius', () => {
		expect(pickCell([a, b], 10, 20.2, 5)?.id).toBe('a');
		expect(cellDistanceKm(a, 10, 20.2)).toBe(0);
		const gap = cellDistanceKm(a, 10, 20.7);
		expect(gap).toBeGreaterThan(20);
		expect(gap).toBeLessThan(23);
		expect(pickCell([a, b], 10, 20.7, 40)?.id).toBe('a');
		expect(pickCell([a, b], 10, 20.8, 40)?.id).toBe('b');
		expect(pickCell([a, b], 10, 20.7, 15)).toBeNull();
		expect(pickCell([a, b], 30, 20, 100)).toBeNull();
	});

	it('handles hulls whose longitudes run past the antimeridian', () => {
		const dateline = cell('d', 0, 179.8, 0.5);
		expect(dateline.hull.some(([lon]) => lon > 180)).toBe(true);
		expect(pickCell([dateline], 0, -179.9, 1)?.id).toBe('d');
		expect(insideRing(dateline.hull, 180.1, 0)).toBe(true);
	});
});

describe('active storms feed', () => {
	const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

	it('revalidates every poll, publishes changed snapshots once and keeps the last one through failures', async () => {
		const bodies: (ActiveStorms | null)[] = [s0 as ActiveStorms, s0 as ActiveStorms, null, s1 as ActiveStorms];
		const requests: RequestInit[] = [];
		const published: string[] = [];
		const feed = new ActiveFeed({
			baseUrl: 'https://data.test/',
			now: () => 0,
			visibility: new FakeVisibility(),
			pollIntervalMs: 1e9,
			fetch: async (_url, init) => {
				requests.push(init ?? {});
				const body = bodies.shift();
				return body ? response(body) : response({}, 503);
			},
			onSnapshot: (snapshot) => published.push(snapshot.published_at),
		});
		feed.start();
		await feed.idle();
		const first = feed.snapshot;
		await feed.poll();
		expect(feed.snapshot).toBe(first);
		await feed.poll();
		expect(feed.failures).toBe(1);
		expect(feed.snapshot).toBe(first);
		await feed.poll();
		expect(feed.failures).toBe(0);
		expect(published).toEqual([s0.published_at, s1.published_at]);
		expect(feed.url.href).toBe('https://data.test/storms/active.json');
		expect(requests.every((init) => init.cache === 'no-cache')).toBe(true);
		feed.stop();
		expect(feed.snapshot).toBeNull();
	});

	it('drops a response that lands after stop', async () => {
		let release: (r: Response) => void = () => {};
		const feed = new ActiveFeed({
			baseUrl: 'https://data.test/', now: () => 0, visibility: new FakeVisibility(),
			fetch: () => new Promise<Response>((resolve) => { release = resolve; }),
		});
		feed.start();
		feed.stop();
		release(response(s0));
		await feed.idle();
		expect(feed.snapshot).toBeNull();
	});
});
