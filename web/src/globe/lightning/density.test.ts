import { describe, expect, it } from 'vitest';
import { channelHash } from './channel';
import { DENSITY, densityGlsl, followShare, heroLot, heroShare, heroTarget, heroWeight } from './density';

const SEEDS = 50_000;
const seeds = Array.from({ length: SEEDS }, (_, i) => (i + 0.5) / SEEDS);

describe('heroLot', () => {
	it('draws about meanWeight times the share with uniform intensities', () => {
		for (const s of [0.05, 0.1, 0.2, 0.3]) {
			const under = seeds.filter((seed) => heroLot(seed, channelHash(seed, 7)) < s).length / SEEDS;
			expect(Math.abs(under - DENSITY.meanWeight * s)).toBeLessThan(0.02);
		}
	});

	it('makes the strongest flash 2.5 times likelier than the weakest', () => {
		const strong = seeds.filter((seed) => heroLot(seed, 1) < 0.1).length;
		const weak = seeds.filter((seed) => heroLot(seed, 0) < 0.1).length;
		expect(Math.abs(strong / weak - 2.5)).toBeLessThan(0.1);
	});

	it('is stable per flash and stays in [0, 1)', () => {
		expect(heroLot(0.37, 0.5)).toBe(heroLot(0.37, 0.5));
		for (const seed of seeds.slice(0, 1000)) {
			const lot = heroLot(seed, 2);
			expect(lot).toBeGreaterThanOrEqual(0);
			expect(lot).toBeLessThan(1);
		}
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

describe('followShare', () => {
	it('moves the share by at most the time constant each frame and jumps at once on a seek', () => {
		let share = 1;
		const wanted = 0.01;
		const dt = 1 / 60;
		for (let frame = 0; frame < 120; frame++) {
			const next = followShare(share, wanted, dt);
			expect(next).toBeLessThanOrEqual(share);
			expect(next).toBeGreaterThanOrEqual(share * (wanted / share) ** (dt / DENSITY.smoothing) - 1e-4);
			share = next;
		}
		expect(share).toBeGreaterThan(wanted);
		expect(Math.log(share / wanted)).toBeCloseTo(Math.log(1 / wanted) * Math.exp(-2 / DENSITY.smoothing), 1);
		expect(followShare(share, wanted, dt, true)).toBe(wanted);
	});

	it('settles exactly on the wanted share', () => {
		let share = 0.5;
		for (let frame = 0; frame < 2000; frame++) share = followShare(share, 1, 1 / 60);
		expect(share).toBe(1);
	});
});

describe('densityGlsl', () => {
	it('uses the same constants as the TypeScript lot and weight', () => {
		expect(densityGlsl).toContain(`channelHash(seed, 3.0) * mix(1.0, ${DENSITY.energyWeight}, clamp(intensity, 0.0, 1.0))`);
		expect(densityGlsl).toContain(`1.0 - smoothstep(share, share * ${DENSITY.edge}, lot)`);
	});
});
