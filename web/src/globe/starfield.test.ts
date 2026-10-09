import { describe, expect, it } from 'vitest';
import { generateStars, MAX_BRIGHTNESS, siderealAngle } from './starfield';

const DEG = Math.PI / 180;
const SIDEREAL_DAY_MS = 86_164_090.5;

describe('generateStars', () => {
	const stars = generateStars(5000);

	it('is deterministic for a seed', () => {
		expect(generateStars(10, 7)).toEqual(generateStars(10, 7));
		expect(generateStars(10, 7)).not.toEqual(generateStars(10, 8));
	});

	it('places stars on the unit sphere with bounded brightness', () => {
		for (const { direction, brightness, warmth } of stars) {
			expect(Math.hypot(...direction)).toBeCloseTo(1, 9);
			expect(brightness).toBeGreaterThan(0);
			expect(brightness).toBeLessThanOrEqual(MAX_BRIGHTNESS);
			expect(warmth).toBeGreaterThanOrEqual(0);
			expect(warmth).toBeLessThanOrEqual(1);
		}
	});

	it('keeps bright stars rare', () => {
		const bright = stars.filter((s) => s.brightness > MAX_BRIGHTNESS / 4).length;
		const faint = stars.filter((s) => s.brightness < MAX_BRIGHTNESS / 10).length;
		expect(bright / stars.length).toBeLessThan(0.03);
		expect(faint / stars.length).toBeGreaterThan(0.75);
	});

	it('covers both hemispheres evenly', () => {
		const north = stars.filter((s) => s.direction[1] > 0).length;
		expect(Math.abs(north / stars.length - 0.5)).toBeLessThan(0.03);
	});
});

describe('siderealAngle', () => {
	it('matches GMST at the J2000 epoch', () => {
		expect(siderealAngle(Date.UTC(2000, 0, 1, 12)) / DEG).toBeCloseTo(280.46061837, 6);
	});

	it('turns once per sidereal day and stays in [0, 2π)', () => {
		const t = Date.UTC(2026, 9, 9, 3);
		const a = siderealAngle(t);
		const b = siderealAngle(t + SIDEREAL_DAY_MS);
		expect(Math.abs(a - b)).toBeLessThan(1e-6);
		for (let h = 0; h < 48; h++) {
			const angle = siderealAngle(t + h * 3_600_000);
			expect(angle).toBeGreaterThanOrEqual(0);
			expect(angle).toBeLessThan(2 * Math.PI);
		}
	});
});
