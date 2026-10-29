import { describe, expect, it } from 'vitest';
import { decodeChunk } from './decode';
import { LateFlashes, LIVE_DELAY_MS, LIVE_DELAYS, NO_DELAY, SourceDelays } from './delay';
import { encodeChunk } from './testing';

describe('SourceDelays', () => {
	it('maps binary source indices to their delay', () => {
		expect([...LIVE_DELAYS.ms.slice(0, 3)]).toEqual([
			LIVE_DELAY_MS['glm-east'],
			LIVE_DELAY_MS['glm-west'],
			LIVE_DELAY_MS['mtg-li'],
		]);
		expect(LIVE_DELAYS.values).toEqual([...new Set(Object.values(LIVE_DELAY_MS))].sort((a, b) => a - b));
	});

	it('plays unknown sources as late as the slowest known one', () => {
		const delays = new SourceDelays({ 'glm-east': 1_000, 'mtg-li': 5_000 });
		expect(delays.min).toBe(0);
		expect(delays.max).toBe(5_000);
		expect(delays.ms[200]).toBe(5_000);
		expect(delays.values).toEqual([0, 1_000, 5_000]);
	});

	it('has no delay by default', () => {
		expect(NO_DELAY.max).toBe(0);
		expect(NO_DELAY.values).toEqual([0]);
	});
});

describe('LateFlashes', () => {
	it('counts flashes loaded after their slot, from chunks ingested since it started', () => {
		const delays = new SourceDelays({ 'glm-east': 10_000, 'mtg-li': 60_000 });
		const late = new LateFlashes(delays, 100_000);
		const chunk = decodeChunk(
			encodeChunk(100, [
				{ offsetMs: -12_000, lat: 0, lon: 0, source: 0 },
				{ offsetMs: -8_000, lat: 0, lon: 0, source: 0 },
				{ offsetMs: -12_000, lat: 0, lon: 0, source: 2 },
			]).buffer,
		);
		late.add(chunk, 100_000, 100_500);
		expect([...late.counts.slice(0, 3)]).toEqual([1, 0, 0]);
		late.add(chunk, 99_000, 200_000);
		expect([...late.counts.slice(0, 3)]).toEqual([1, 0, 0]);
	});
});
