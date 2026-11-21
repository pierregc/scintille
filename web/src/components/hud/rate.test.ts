import { describe, expect, it } from 'vitest';
import { QUALITY_FLAG_VALUES } from '../../contract/types';
import { decodeChunk } from '../../globe/live/decode';
import { NO_DELAY, SourceDelays } from '../../globe/live/delay';
import { FlashRing } from '../../globe/live/ring';
import { encodeChunk, type FakeFlash } from '../../globe/live/testing';
import type { ChunkRef, LiveManifest } from '../../contract/types';
import { flashRate, rateLabel, receivedRate } from './rate';

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

describe('receivedRate', () => {
	const manifest = (counts: (number | undefined)[]) =>
		({
			chunks: counts.map((received_count, i) => ({
				start: new Date(T0 + i * 20_000).toISOString(),
				end: new Date(T0 + (i + 1) * 20_000).toISOString(),
				received_count,
			})) as ChunkRef[],
		}) as LiveManifest;

	it('averages the last minute of chunks', () => {
		expect(receivedRate(manifest([9000, 300, 600, 900]))).toBeCloseTo(30);
	});

	it('is unknown without counts', () => {
		expect(receivedRate(manifest([300, undefined, 900]))).toBeNull();
		expect(receivedRate(manifest([]))).toBeNull();
		expect(receivedRate(null)).toBeNull();
	});
});

describe('rateLabel', () => {
	it('rounds large rates and keeps a decimal for small ones', () => {
		expect(rateLabel(47.4)).toBe('47 flashes/s shown');
		expect(rateLabel(3.26)).toBe('3.3 flashes/s shown');
		expect(rateLabel(0)).toBe('0.0 flashes/s shown');
	});

	it('adds the received rate when known', () => {
		expect(rateLabel(47.4, 61.2)).toBe('47 flashes/s shown · 61 received');
	});
});
