import { describe, expect, it } from 'vitest';
import { FpsMonitor, guessTier, lowerTier, PRESETS, surfaceBudgetMb, tierFromSearch } from './quality';

describe('guessTier', () => {
	it('starts phones and weak GPUs low', () => {
		expect(guessTier({ gpu: 'Mali-G57', screenMin: 412, coarsePointer: true })).toBe('low');
		expect(guessTier({ gpu: 'Intel(R) UHD Graphics 620', screenMin: 900, coarsePointer: false })).toBe('low');
		expect(guessTier({ screenMin: 390, coarsePointer: true })).toBe('low');
		expect(guessTier({ screenMin: 1080, coarsePointer: false, memoryGb: 2 })).toBe('low');
		expect(guessTier({ gpu: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)', screenMin: 900, coarsePointer: false })).toBe('low');
		expect(guessTier({ gpu: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', screenMin: 1080, coarsePointer: false })).toBe('medium');
	});

	it('starts 2015 to 2018 laptop GPUs and masked Intel Macs medium', () => {
		expect(guessTier({ gpu: 'ANGLE (ATI Technologies Inc., AMD Radeon Pro 555X OpenGL Engine, OpenGL 4.1)', screenMin: 900, coarsePointer: false })).toBe('medium');
		expect(guessTier({ gpu: 'ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)', screenMin: 1080, coarsePointer: false })).toBe('medium');
		expect(guessTier({ gpu: 'NVIDIA GeForce GTX 950M', screenMin: 1080, coarsePointer: false })).toBe('medium');
		expect(guessTier({ gpu: 'AMD Radeon Pro 5500M', screenMin: 1080, coarsePointer: false })).toBe('high');
		expect(guessTier({ gpu: 'Apple GPU', screenMin: 900, coarsePointer: false, cores: 4 })).toBe('medium');
		expect(guessTier({ gpu: 'Apple GPU', screenMin: 900, coarsePointer: false, cores: 10 })).toBe('high');
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

	it('lights the clouds from a 1024 px flash map on medium and high, none on low', () => {
		expect([PRESETS.low.lightMapWidth, PRESETS.medium.lightMapWidth, PRESETS.high.lightMapWidth]).toEqual([0, 1024, 1024]);
		for (const preset of Object.values(PRESETS)) expect(preset.lightMapWidth > 0).toBe(preset.cloudLight);
	});
});

describe('wind tiers', () => {
	it('bakes the wind fibres at half the resolution on low', () => {
		expect([PRESETS.low.windBake, PRESETS.medium.windBake, PRESETS.high.windBake]).toEqual([0.5, 0.75, 1]);
	});
});

describe('cloud relief', () => {
	it('marches the clouds on high only', () => {
		expect([PRESETS.low.cloudVolume, PRESETS.medium.cloudVolume]).toEqual([0, 0]);
		expect(PRESETS.high.cloudVolume).toBeGreaterThan(0);
	});
});

describe('FpsMonitor', () => {
	const run = (monitor: FpsMonitor, fps: number, ms: number, from = 0) => {
		const results: boolean[] = [];
		for (let t = from; t <= from + ms; t += 1000 / fps) results.push(monitor.frame(t));
		return results.filter(Boolean).length;
	};

	it('downgrades a tier every 3 s of sustained low frame rate, with a cooldown', () => {
		expect(run(new FpsMonitor(), 60, 20_000)).toBe(0);
		expect(run(new FpsMonitor(), 20, 3_500)).toBe(1);
		expect(run(new FpsMonitor(), 20, 6_500)).toBe(2);
		expect(run(new FpsMonitor({ cooldownMs: 10_000 }), 20, 9_500)).toBe(1);
	});

	it('downgrades a screen held under 45 fps, not one at 60', () => {
		expect(run(new FpsMonitor(), 58, 6000)).toBe(0);
		expect(run(new FpsMonitor(), 40, 3500)).toBe(1);
	});

	it('starts over after a reset', () => {
		const monitor = new FpsMonitor();
		run(monitor, 20, 4000);
		monitor.reset();
		expect(run(monitor, 60, 4000, 4000)).toBe(0);
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
