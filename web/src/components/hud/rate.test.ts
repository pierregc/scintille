import { describe, expect, it } from 'vitest';
import { QUALITY_FLAG_VALUES } from '../../contract/types';
import { decodeChunk } from '../../globe/live/decode';
import { NO_DELAY, SourceDelays } from '../../globe/live/delay';
import { FlashRing } from '../../globe/live/ring';
import { encodeChunk, type FakeFlash } from '../../globe/live/testing';
import { flashRate, rateLabel } from './rate';

const START = 1_800_000_000;
const T0 = START * 1000;

function ring(flashes: FakeFlash[]): FlashRing {
	const r = new FlashRing(64);
	r.push(decodeChunk(encodeChunk(START, flashes).buffer));
	return r;
}

describe('flashRate', () => {
	it('counts the flashes shown during the window', () => {
		const r = ring([
			{ offsetMs: 0, lat: 0, lon: 0, source: 0 },
			{ offsetMs: 30_000, lat: 0, lon: 0, source: 0 },
			{ offsetMs: 70_000, lat: 0, lon: 0, source: 1 },
			{ offsetMs: 90_000, lat: 0, lon: 0, source: 2 },
			{ offsetMs: 95_000, lat: 0, lon: 0, source: 0 },
		]);
		expect(flashRate(r, NO_DELAY, T0 + 95_000, 60_000)).toBeCloseTo(3 / 60);
	});

	it('follows each source delay', () => {
		const delays = new SourceDelays({ 'glm-east': 0, 'glm-west': 0, 'mtg-li': 600_000 });
		const r = ring([
			{ offsetMs: 0, lat: 0, lon: 0, source: 2 },
			{ offsetMs: 600_000, lat: 0, lon: 0, source: 0 },
			{ offsetMs: 610_000, lat: 0, lon: 0, source: 2 },
		]);
		expect(flashRate(r, delays, T0 + 630_000, 60_000)).toBeCloseTo(2 / 60);
	});

	it('skips flashes owned by another satellite', () => {
		const r = ring([
			{ offsetMs: 0, lat: 0, lon: 0, source: 0 },
			{ offsetMs: 1_000, lat: 0, lon: 0, source: 1 },
		]);
		r.quality[r.slot(1)] = 1 << QUALITY_FLAG_VALUES.indexOf('outside-owner-zone');
		expect(flashRate(r, NO_DELAY, T0 + 5_000)).toBeCloseTo(1 / 10);
	});
});

describe('rateLabel', () => {
	it('rounds large rates and keeps a decimal for small ones', () => {
		expect(rateLabel(47.4)).toBe('47 flashes/s');
		expect(rateLabel(3.26)).toBe('3.3 flashes/s');
		expect(rateLabel(0)).toBe('0.0 flashes/s');
	});
});
