import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoverageMap } from '../../contract/types';
import { drawGaps, gapAt, type MaskContext, parseCoverage } from './map';

const FIXTURES = new URL('../../../../fixtures/live/', import.meta.url);
let map: CoverageMap;

beforeAll(async () => {
	map = parseCoverage(JSON.parse(await readFile(new URL('coverage.geojson', FIXTURES), 'utf8')));
});

describe('parseCoverage', () => {
	it('rejects another major version or a non collection', () => {
		expect(() => parseCoverage({ ...map, schema_version: '9.0.0' })).toThrow(/major/);
		expect(() => parseCoverage({ type: 'Feature' })).toThrow();
	});
});

describe('gapAt', () => {
	it('marks Asia, Oceania and the poles, not the Americas', () => {
		expect(gapAt(map, 30, 100)).toBe(true);
		expect(gapAt(map, -25, 135)).toBe(true);
		expect(gapAt(map, 85, -100)).toBe(true);
		expect(gapAt(map, -80, -70)).toBe(true);
		expect(gapAt(map, 35, -95)).toBe(false);
		expect(gapAt(map, 0, 170)).toBe(false);
	});

	it('follows the GeoJSON edge across the antimeridian', () => {
		expect(gapAt(map, 0, 155.5)).toBe(true);
		expect(gapAt(map, 0, 156.5)).toBe(false);
		expect(gapAt(map, 0, -8.5)).toBe(false);
		expect(gapAt(map, 0, -7.5)).toBe(true);
	});

	it('leaves Europe and Africa clear once MTG LI is in the map', async () => {
		const contract = parseCoverage(JSON.parse(await readFile(new URL('../../../../data/contract/coverage.geojson', import.meta.url), 'utf8')));
		expect(gapAt(contract, 48.9, 2.3)).toBe(false);
		expect(gapAt(contract, 6.5, 3.4)).toBe(false);
		expect(gapAt(contract, 39.9, 116.4)).toBe(true);
	});
});

class RecordingContext implements MaskContext {
	fillStyle: MaskContext['fillStyle'] = '';
	readonly fills: number[] = [];
	#points = 0;
	beginPath(): void {
		this.#points = 0;
	}
	moveTo(x: number, y: number): void {
		this.lineTo(x, y);
	}
	lineTo(x: number, y: number): void {
		expect(x).toBeGreaterThanOrEqual(0);
		expect(x).toBeLessThanOrEqual(2048);
		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThanOrEqual(1024);
		this.#points++;
	}
	closePath(): void {}
	fill(): void {
		this.fills.push(this.#points);
	}
	clearRect(): void {
		this.fills.length = 0;
	}
}

describe('drawGaps', () => {
	it('paints the no coverage area only', () => {
		const ctx = new RecordingContext();
		drawGaps(ctx, map, 2048, 1024);
		const gaps = map.features.filter((f) => f.properties.kind === 'no-coverage').flatMap((f) => f.geometry.coordinates);
		expect(ctx.fills).toHaveLength(gaps.length);
		expect(ctx.fills.every((points) => points > 0)).toBe(true);
	});
});
