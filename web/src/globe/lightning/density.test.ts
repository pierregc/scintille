import { describe, expect, it } from 'vitest';
import { channelHash, flashSeed } from './channel';
import { DENSITY, densityGlsl, followShare, heroLot, heroShare, heroTarget, heroWeight, pointWeight } from './density';

const SEEDS = 200_000;
/** Seeds of flashes spread over a day and a storm-sized box, with intensities uniform and independent of them. */
const flashes = Array.from({ length: SEEDS }, (_, i) => ({
	seed: flashSeed(1_793_000_000_000 + i * 431.7, 3 + (i % 97) * 0.013, 19 + (i % 89) * 0.017),
	intensity: (i * 0.6180339887) % 1,
}));

describe('heroLot', () => {
	it('draws about meanWeight times the share with uniform intensities', () => {
		for (const s of [0.001, 0.01, 0.05, 0.1, 0.2, 0.3]) {
			const under = flashes.filter((f) => heroLot(f.seed, f.intensity) < s).length / SEEDS;
			expect(Math.abs(under - DENSITY.meanWeight * s)).toBeLessThan(Math.min(0.02, 0.15 * DENSITY.meanWeight * s));
		}
	});

	it('makes the strongest flash 2.5 times likelier than the weakest', () => {
		const strong = flashes.filter((f) => heroLot(f.seed, 1) < 0.1).length;
		const weak = flashes.filter((f) => heroLot(f.seed, 0) < 0.1).length;
		expect(Math.abs(strong / weak - 2.5)).toBeLessThan(0.1);
	});

	it('is stable per flash and stays in [0, 1)', () => {
		expect(heroLot(0.37, 0.5)).toBe(heroLot(0.37, 0.5));
		for (const { seed } of flashes.slice(0, 1000)) {
			const lot = heroLot(seed, 2);
			expect(lot).toBeGreaterThanOrEqual(0);
			expect(lot).toBeLessThan(1);
		}
	});

	it('survives the float32 seed of the GPU, where a second hash would not', () => {
		const f32 = flashes.slice(0, 10_000).map(({ seed, intensity }) => ({ seed, intensity, gpu: Math.fround(seed) }));
		for (const { seed, intensity, gpu } of f32) expect(Math.abs(heroLot(gpu, Math.fround(intensity)) - heroLot(seed, intensity))).toBeLessThan(1e-6);
		const rehashed = f32.filter(({ seed, gpu }) => Math.abs(channelHash(gpu, 3) - channelHash(seed, 3)) > 0.01).length;
		expect(rehashed / f32.length).toBeGreaterThan(0.1);
	});
});

describe('heroTarget', () => {
	it('hits the targets at the replay speeds and every flash at 1×', () => {
		expect(heroTarget(60)).toBe(50);
		expect(heroTarget(600)).toBe(20);
		expect(heroTarget(3600)).toBe(8);
		expect(heroTarget(1)).toBe(Infinity);
	});

	it('interpolates between the keys and clamps outside them', () => {
		const mid = heroTarget(200);
		expect(mid).toBeGreaterThan(20);
		expect(mid).toBeLessThan(50);
		expect(heroTarget(10_000)).toBe(8);
		expect(heroTarget(0.5)).toBe(Infinity);
	});
});

describe('heroShare', () => {
	it('sizes the share so the sample holds the target', () => {
		expect(heroShare(20, 6000)).toBeCloseTo(0.0022, 4);
		expect(heroShare(50, 10)).toBe(1);
		expect(heroShare(Infinity, 1e6)).toBe(1);
		expect(heroShare(8, 0)).toBe(1);
	});
});

describe('heroWeight', () => {
	it('keeps flashes under the share whole and fades them out over the edge', () => {
		expect(heroWeight(0.1, 0.2)).toBe(1);
		expect(heroWeight(0.2, 0.2)).toBe(1);
		expect(heroWeight(0.2 * DENSITY.edge, 0.2)).toBe(0);
		expect(heroWeight(0.21, 0.2)).toBeGreaterThan(0);
		expect(heroWeight(0.21, 0.2)).toBeLessThan(1);
		expect(heroWeight(0.999, 1)).toBe(1);
	});
});

describe('pointWeight', () => {
	it('keeps a point from afar only, and half a sprite without cloud light', () => {
		expect(pointWeight(0, 0)).toBe(0);
		expect(pointWeight(0.7, 0)).toBe(0);
		expect(pointWeight(0.85, 0)).toBeCloseTo(0.5, 9);
		expect(pointWeight(1, 0)).toBe(1);
		expect(pointWeight(0, 1)).toBe(DENSITY.weakGlow);
		expect(pointWeight(1, 1)).toBe(1);
	});
});

describe('followShare', () => {
	it('moves the share by at most the time constant each frame and jumps at once on a seek', () => {
		let share = 1;
		const wanted = 0.01;
		const dt = 1 / 60;
		for (let frame = 0; frame < 30; frame++) {
			const next = followShare(share, wanted, dt);
			expect(next).toBeLessThanOrEqual(share);
			expect(next).toBeGreaterThanOrEqual(share * (wanted / share) ** (dt / DENSITY.smoothing) - 1e-9);
			share = next;
		}
		expect(share).toBeGreaterThan(wanted);
		expect(Math.log(share / wanted)).toBeCloseTo(Math.log(1 / wanted) * (1 - dt / DENSITY.smoothing) ** 30, 6);
		expect(followShare(share, wanted, dt, true)).toBe(wanted);
	});

	it('settles exactly on the wanted share, whatever its size', () => {
		let share = 0.5;
		for (let frame = 0; frame < 600; frame++) share = followShare(share, 1, 1 / 60);
		expect(share).toBe(1);
		share = 0.001;
		share = followShare(share, 0.0004, 1 / 60);
		expect(share).toBeGreaterThan(0.0009);
		for (let frame = 0; frame < 600; frame++) share = followShare(share, 0.0004, 1 / 60);
		expect(share).toBe(0.0004);
	});
});

describe('densityGlsl', () => {
	it('uses the same constants as the TypeScript lot and weight', () => {
		expect(densityGlsl).toContain(`seed * mix(1.0, ${DENSITY.energyWeight}, clamp(intensity, 0.0, 1.0))`);
		expect(densityGlsl).toContain(`1.0 - smoothstep(share, share * ${DENSITY.edge}, lot)`);
		expect(densityGlsl).toContain(`max(smoothstep(${DENSITY.pointFarness[0]}, ${DENSITY.pointFarness[1]}.0, farness), lightMapOff * ${DENSITY.weakGlow})`);
		expect(densityGlsl).toContain('smoothstep(pointBudgetFrom - budgetFade, pointBudgetFrom, at)');
	});
});
