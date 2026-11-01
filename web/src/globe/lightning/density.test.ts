import { describe, expect, it } from 'vitest';
import { channelHash, flashKind, flashSeed } from './channel';
import { DENSITY, densityGlsl, flashLot, followShare, heroLot, heroShare, heroTarget, heroWeight, pointWeight } from './density';
import { isGround } from './kind';

const SEEDS = 200_000;
/** Seeds of flashes spread over a day and a storm-sized box, with intensities uniform and independent of them. */
const flashes = Array.from({ length: SEEDS }, (_, i) => ({
	seed: flashSeed(1_793_000_000_000 + i * 431.7, 3 + (i % 97) * 0.013, 19 + (i % 89) * 0.017),
	intensity: (i * 0.6180339887) % 1,
}));
/** Kind of each flash as a short, small flash: cloud-to-ground for 30 % of the seeds. */
const ground = flashes.map((f) => isGround(flashKind(f.seed, 200, 300)));

describe('heroLot', () => {
	it('draws about meanWeight times the share with uniform intensities and the kinds of short flashes', () => {
		for (const s of [0.001, 0.01, 0.05, 0.1]) {
			const under = flashes.filter((f, i) => heroLot(f.seed, f.intensity, ground[i]) < s).length / SEEDS;
			expect(Math.abs(under - DENSITY.meanWeight * s)).toBeLessThan(Math.min(0.02, 0.15 * DENSITY.meanWeight * s));
		}
	});

	it('makes the strongest flash 2.5 times likelier than the weakest', () => {
		const strong = flashes.filter((f) => heroLot(f.seed, 1, false) < 0.1).length;
		const weak = flashes.filter((f) => heroLot(f.seed, 0, false) < 0.1).length;
		expect(Math.abs(strong / weak - 2.5)).toBeLessThan(0.1);
	});

	it('makes a cloud-to-ground flash 2.5 times likelier than an in-cloud one, its kind drawn as the renderer draws it', () => {
		const onGround = flashes.filter((f, i) => ground[i]);
		const inCloud = flashes.filter((f, i) => !ground[i]);
		const drawn = (list: typeof flashes) => list.filter((f) => flashLot(f.seed, f.intensity, 200, 300) < 0.05).length / list.length;
		expect(Math.abs(drawn(onGround) / drawn(inCloud) - 2.5)).toBeLessThan(0.15);
		expect(DENSITY.meanWeight).toBeCloseTo(1.5 * (0.3 / 0.4 + 0.7), 6);
	});

	it('is stable per flash and stays in [0, 1)', () => {
		expect(heroLot(0.37, 0.5, true)).toBe(heroLot(0.37, 0.5, true));
		for (const { seed } of flashes.slice(0, 1000)) {
			for (const lot of [heroLot(seed, 2, false), heroLot(seed, -1, true)]) {
				expect(lot).toBeGreaterThanOrEqual(0);
				expect(lot).toBeLessThan(1);
			}
		}
	});

	it('survives the float32 seed of the GPU, where a second hash would not', () => {
		const f32 = flashes.slice(0, 10_000).map(({ seed, intensity }) => ({ seed, intensity, gpu: Math.fround(seed) }));
		for (const { seed, intensity, gpu } of f32) for (const g of [false, true]) expect(Math.abs(heroLot(gpu, Math.fround(intensity), g) - heroLot(seed, intensity, g))).toBeLessThan(1e-6);
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
		expect(heroShare(20, 6000)).toBeCloseTo(20 / (DENSITY.meanWeight * 6000), 9);
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
		expect(densityGlsl).toContain(`seed * mix(1.0, ${DENSITY.energyWeight}, clamp(intensity, 0.0, 1.0)) * (ground ? ${DENSITY.groundWeight} : 1.0)`);
		expect(densityGlsl).toContain(`1.0 - smoothstep(share, share * ${DENSITY.edge}, lot)`);
		expect(densityGlsl).toContain(`max(smoothstep(${DENSITY.pointFarness[0]}, ${DENSITY.pointFarness[1]}.0, far), off * ${DENSITY.weakGlow})`);
		expect(densityGlsl).toContain('smoothstep(pointBudgetFrom - budgetFade, pointBudgetFrom, at)');
	});
});
