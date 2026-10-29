import { describe, expect, it } from 'vitest';
import { decodeChunk } from '../../globe/live/decode';
import { NO_DELAY, SourceDelays } from '../../globe/live/delay';
import { FlashRing } from '../../globe/live/ring';
import { encodeChunk, type FakeFlash } from '../../globe/live/testing';
import { debugEnabled, playedFlashes, shortSourceLabel, sourceStats } from './stats';

const START = 1_800_000_000;
const T0 = START * 1000;

function ring(flashes: FakeFlash[]): FlashRing {
	const r = new FlashRing(64);
	r.push(decodeChunk(encodeChunk(START, flashes).buffer));
	return r;
}

describe('debugEnabled', () => {
	it('follows the build unless the URL says otherwise', () => {
		expect(debugEnabled('', false)).toBe(false);
		expect(debugEnabled('', true)).toBe(true);
		expect(debugEnabled('?debug', false)).toBe(true);
		expect(debugEnabled('?debug=1', false)).toBe(true);
		expect(debugEnabled('?debug=0', true)).toBe(false);
	});
});

describe('sourceStats', () => {
	it('counts held, played and pending flashes per source', () => {
		const delays = new SourceDelays({ 'glm-east': 0, 'glm-west': 0, 'mtg-li': 30_000 });
		const r = ring([
			{ offsetMs: 0, lat: 10, lon: 20, source: 0 },
			{ offsetMs: 50_000, lat: 10, lon: 20, source: 0 },
			{ offsetMs: 60_000, lat: 40, lon: 5, source: 2 },
			{ offsetMs: 61_000, lat: 40, lon: 5, source: 7 },
		]);
		const stats = sourceStats(r, delays, T0 + 70_000);
		expect(stats.map((s) => s.label)).toEqual(['GLM E', 'GLM W', 'MTG LI', '#7']);
		expect(stats[0]).toEqual({ label: 'GLM E', held: 2, lastMinute: 1, pending: 0, late: 0 });
		expect(stats[1]).toMatchObject({ held: 0, lastMinute: 0, pending: 0 });
		expect(stats[2]).toMatchObject({ held: 1, lastMinute: 0, pending: 1 });
		expect(stats[3]).toMatchObject({ held: 1, pending: 1 });
	});
});

describe('playedFlashes', () => {
	it('lists played flashes newest first, skipping those still delayed', () => {
		const delays = new SourceDelays({ 'glm-east': 0, 'glm-west': 0, 'mtg-li': 10_000 });
		const r = ring([
			{ offsetMs: 1000, lat: 1, lon: 1, source: 0 },
			{ offsetMs: 2000, lat: 2, lon: 2, source: 0 },
			{ offsetMs: 3000, lat: 3, lon: 3, source: 2 },
			{ offsetMs: 9000, lat: 4, lon: 4, source: 1 },
		]);
		const rows = playedFlashes(r, delays, T0 + 5000, 10);
		expect(rows.map((f) => f.time - T0)).toEqual([2000, 1000]);
		expect(rows[0]).toMatchObject({ id: 1, source: 0, durationMs: 250, areaKm2: 100 });
		expect(rows[0].lat).toBeCloseTo(2, 2);
		expect(playedFlashes(r, NO_DELAY, T0 + 10_000, 2).map((f) => f.id)).toEqual([3, 2]);
	});
});

describe('format', () => {
	it('writes short source labels', () => {
		expect([0, 1, 2, 7].map(shortSourceLabel)).toEqual(['GLM E', 'GLM W', 'MTG LI', '#7']);
	});
});
