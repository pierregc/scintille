import { describe, expect, it } from 'vitest';
import { FpsMonitor, guessTier, lowerTier, PRESETS, surfaceBudgetMb, tierFromSearch } from './quality';

describe('guessTier', () => {
	it('starts phones and weak GPUs low', () => {
		expect(guessTier({ gpu: 'Mali-G57', screenMin: 412, coarsePointer: true })).toBe('low');
		expect(guessTier({ gpu: 'Intel(R) UHD Graphics 620', screenMin: 900, coarsePointer: false })).toBe('low');
		expect(guessTier({ screenMin: 390, coarsePointer: true })).toBe('low');
		expect(guessTier({ screenMin: 1080, coarsePointer: false, memoryGb: 2 })).toBe('low');
	});

	it('starts known strong GPUs high, unknown ones medium', () => {
		expect(guessTier({ gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', screenMin: 900, coarsePointer: false })).toBe('high');
		expect(guessTier({ gpu: 'NVIDIA GeForce RTX 3060', screenMin: 1080, coarsePointer: false })).toBe('high');
		expect(guessTier({ screenMin: 1080, coarsePointer: false })).toBe('medium');
		expect(guessTier({ gpu: 'Apple GPU', screenMin: 390, coarsePointer: true })).toBe('medium');
	});
});

describe('tiers', () => {
	it('reads the URL override', () => {
		expect(tierFromSearch('?quality=low')).toBe('low');
		expect(tierFromSearch('?quality=ultra')).toBeNull();
	});

	it('steps down and stops at low', () => {
		expect(lowerTier('high')).toBe('medium');
		expect(lowerTier('low')).toBe('low');
	});
});

describe('cloud tiers', () => {
	it('loads 2k clouds on low and 4k above', () => {
		expect([PRESETS.low.clouds, PRESETS.medium.clouds, PRESETS.high.clouds]).toEqual(['2k', '4k', '4k']);
	});

	it('lights the clouds from a finer flash map on high, none on low', () => {
		expect([PRESETS.low.lightMapWidth, PRESETS.medium.lightMapWidth, PRESETS.high.lightMapWidth]).toEqual([0, 1024, 2048]);
		for (const preset of Object.values(PRESETS)) expect(preset.lightMapWidth > 0).toBe(preset.cloudLight);
	});
});

describe('FpsMonitor', () => {
	const run = (monitor: FpsMonitor, fps: number, ms: number, from = 0) => {
		const results: boolean[] = [];
		for (let t = from; t <= from + ms; t += 1000 / fps) results.push(monitor.frame(t));
		return results.filter(Boolean).length;
	};

	it('downgrades under sustained low frame rate, with a cooldown', () => {
		const monitor = new FpsMonitor();
		expect(run(monitor, 60, 20_000)).toBe(0);
		expect(run(monitor, 20, 12_000, 20_000)).toBe(1);
		expect(run(monitor, 20, 6_000, 32_000)).toBe(1);
	});

	it('ignores the gap of a hidden tab', () => {
		const monitor = new FpsMonitor();
		monitor.frame(0);
		monitor.frame(16);
		expect(monitor.frame(60_000)).toBe(false);
	});
});

describe('surfaceBudgetMb', () => {
	it('gives no tiles to the low tier and fewer to phones', () => {
		expect(surfaceBudgetMb('low', false)).toBe(0);
		expect(surfaceBudgetMb('high', false)).toBe(96);
		expect(surfaceBudgetMb('medium', false)).toBe(96);
		expect(surfaceBudgetMb('medium', true)).toBe(40);
		expect(surfaceBudgetMb('low', true)).toBe(0);
	});
});
