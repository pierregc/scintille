import { describe, expect, it } from 'vitest';
import { LIVE_DELAY_MS, LIVE_DELAYS, NO_DELAY, SourceDelays } from './delay';

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
