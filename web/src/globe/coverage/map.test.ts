import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoverageMap, Source } from '../../contract/types';
import { downSources, drawGaps, gapAt, type MaskContext, parseCoverage } from './map';

const FIXTURES = new URL('../../../../fixtures/live/', import.meta.url);
let map: CoverageMap;

beforeAll(async () => {
	map = parseCoverage(JSON.parse(await readFile(new URL('coverage.geojson', FIXTURES), 'utf8')));
});

const none = new Set<Source>();
const westDown = new Set<Source>(['glm-west']);

describe('parseCoverage', () => {
	it('rejects another major version or a non collection', () => {
		expect(() => parseCoverage({ ...map, schema_version: '9.0.0' })).toThrow(/major/);
		expect(() => parseCoverage({ type: 'Feature' })).toThrow();
	});
});

describe('downSources', () => {
	it('keeps the offline sources only', () => {
		const sources = [
			{ source: 'glm-east', state: 'live' },
			{ source: 'glm-west', state: 'offline' },
			{ source: 'mtg-li', state: 'delayed' },
		] as const;
		expect(downSources({ sources: sources.map((s) => ({ ...s, last_event_time: null, last_ingest_time: null })) })).toEqual(
			westDown,
		);
		expect(downSources(null)).toEqual(none);
	});
});

describe('gapAt', () => {
	it('marks Asia, Oceania and the poles, not the Americas', () => {
		expect(gapAt(map, none, 30, 100)).toEqual({ kind: 'no-coverage' });
		expect(gapAt(map, none, -25, 135)).toEqual({ kind: 'no-coverage' });
		expect(gapAt(map, none, 85, -100)).toEqual({ kind: 'no-coverage' });
		expect(gapAt(map, none, -80, -70)).toEqual({ kind: 'no-coverage' });
		expect(gapAt(map, none, 35, -95)).toBeNull();
		expect(gapAt(map, none, 0, 170)).toBeNull();
	});

	it('follows the GeoJSON edge across the antimeridian', () => {
		expect(gapAt(map, none, 0, 155.5)).toEqual({ kind: 'no-coverage' });
		expect(gapAt(map, none, 0, 156.5)).toBeNull();
		expect(gapAt(map, none, 0, -8.5)).toBeNull();
		expect(gapAt(map, none, 0, -7.5)).toEqual({ kind: 'no-coverage' });
	});

	it('greys out a down source where no live source sees', () => {
		expect(gapAt(map, westDown, 20, -160)).toEqual({ kind: 'down', sources: ['glm-west'] });
		expect(gapAt(map, westDown, 0, 175)).toEqual({ kind: 'down', sources: ['glm-west'] });
		expect(gapAt(map, westDown, 35, -105)).toBeNull();
		expect(gapAt(map, westDown, 30, 100)).toEqual({ kind: 'no-coverage' });
	});
});

class RecordingContext implements MaskContext {
	fillStyle: MaskContext['fillStyle'] = '';
	globalCompositeOperation: GlobalCompositeOperation = 'source-over';
	readonly fills: { mode: GlobalCompositeOperation; points: number }[] = [];
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
		this.fills.push({ mode: this.globalCompositeOperation, points: this.#points });
	}
	clearRect(): void {
		this.fills.length = 0;
	}
}

describe('drawGaps', () => {
	it('paints the no coverage area, then cuts out every live footprint', () => {
		const ctx = new RecordingContext();
		drawGaps(ctx, map, none, 2048, 1024);
		expect(ctx.fills.map((f) => f.mode)).toEqual(['source-over', 'destination-out', 'destination-out', 'destination-out']);
		expect(ctx.globalCompositeOperation).toBe('source-over');
	});

	it('paints a down footprint and cuts out only the live ones', () => {
		const ctx = new RecordingContext();
		drawGaps(ctx, map, westDown, 2048, 1024);
		expect(ctx.fills.map((f) => f.mode)).toEqual(['source-over', 'source-over', 'source-over', 'destination-out']);
	});
});
