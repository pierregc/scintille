import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRIDS, pathDistanceKm, queryTiles, roundCoord, shownKm, tileOf } from './geo';

interface Fixture {
	tile_of: [number, number, number, number][];
	query_tiles: [number, number, number, number[]][];
	paths: { path: [number, number][]; radius_km: number; tiles: number[]; queries: [number, number, number][] }[];
}

const fixture: Fixture = JSON.parse(readFileSync(new URL('../../../fixtures/search/geometry.json', import.meta.url), 'utf8'));

describe('search geometry, shared with the pipeline', () => {
	it('numbers tiles like the pipeline', () => {
		for (const [lat, lon, fine, coarse] of fixture.tile_of) expect([tileOf(lat, lon), tileOf(lat, lon, GRIDS.coarse)]).toEqual([fine, coarse]);
		for (const [lat, lon, km, tiles] of fixture.query_tiles) expect(queryTiles(lat, lon, km)).toEqual(tiles);
	});

	it('measures the distance to the path like a dense reference', () => {
		for (const { path, radius_km, queries } of fixture.paths) {
			for (const [lat, lon, distance] of queries) expect(pathDistanceKm(lat, lon, path, radius_km)).toBeCloseTo(distance, 0);
		}
	});

	it('finds every storm within reach in the query tiles', () => {
		for (const { path, radius_km, tiles } of fixture.paths) {
			const own = new Set(tiles);
			for (const [lat, lon] of fixture.paths.flatMap((c) => c.queries.map(([a, b]) => [a, b]))) {
				const distance = pathDistanceKm(lat, lon, path, radius_km);
				for (const km of [10, 200, 500, 3000]) {
					if (distance <= km) expect(queryTiles(lat, lon, km).some((t) => own.has(t))).toBe(true);
				}
			}
		}
	});
});

describe('search geometry', () => {
	it('crosses the date line and measures arcs, not only points', () => {
		expect(pathDistanceKm(-17.7, 180, [[-17.7, 179.5], [-17.7, -179.5]])).toBeLessThan(0.1);
		expect(pathDistanceKm(0, 0, [[0, -5], [0, 5]])).toBeLessThan(0.01);
		expect(pathDistanceKm(1, 0, [[0, -5], [0, 5]])).toBeCloseTo(111.2, 0);
	});

	it('subtracts the storm radius without going below zero', () => {
		expect(pathDistanceKm(1, 0, [[0, 0]], 50)).toBeCloseTo(61.2, 0);
		expect(pathDistanceKm(0, 0, [[0, 0]], 50)).toBe(0);
		expect(pathDistanceKm(0, 0, [])).toBe(Infinity);
	});

	it('takes every longitude near a pole', () => {
		expect(queryTiles(89.5, 0, 100)).toHaveLength(180);
	});

	it('rounds points to 0.1° and distances to 10 km', () => {
		expect(roundCoord(45.764)).toBe(45.8);
		expect(roundCoord(-4.85)).toBe(-4.8);
		expect(shownKm(44)).toBe(40);
	});
});
