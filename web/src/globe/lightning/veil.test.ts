import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../sun';
import { SKELETON } from './skeleton';
import { cloudCrossing, cloudTransmission, cloudVeil, VEIL } from './veil';

const R = 6371;
const SHELL = R + 10;

describe('cloud veil', () => {
	it('finds where the line of sight leaves the cloud shell', () => {
		const ground: Vec3 = [R, 0, 0];
		expect(cloudCrossing(ground, [R + 400, 0, 0], SHELL)).toEqual([SHELL, 0, 0]);
		// Seen from the side, the line of sight leaves the cloud towards the camera.
		const side = cloudCrossing(ground, [R + 160, 500, 0], SHELL);
		expect(Math.hypot(...side)).toBeCloseTo(SHELL, 6);
		expect(side[1]).toBeGreaterThan(20);
		expect(cloudCrossing([R + 11, 0, 0], [R + 400, 0, 0], SHELL)).toEqual([R + 11, 0, 0]);
		expect(cloudCrossing(ground, [R + 5, 1, 0], SHELL)).toEqual(ground);
	});

	it('hides a channel below a thick cloud, more so at a slant, and leaves it whole in clear air', () => {
		expect(cloudTransmission(0, 1)).toBe(1);
		expect(cloudTransmission(0.92, 1)).toBeLessThan(0.01);
		expect(cloudTransmission(0.3, 1)).toBeGreaterThan(0.45);
		expect(cloudTransmission(0.3, 0.3)).toBeLessThan(cloudTransmission(0.3, 1));
		let previous = 1;
		for (let a = 0.05; a <= 1; a += 0.05) {
			expect(cloudTransmission(a, 1)).toBeLessThan(previous);
			previous = cloudTransmission(a, 1);
		}
	});

	it('keeps a channel crisp in clear air and spreads it deeper in the cloud', () => {
		expect(cloudVeil(0, 9, 0.23, 1.6)).toEqual({ width: 1.6, light: 1 });
		const top = cloudVeil(0.92, SKELETON.cloudTopKm, 0.23, 1.6);
		const base = cloudVeil(0.92, SKELETON.cloudBaseKm, 0.23, 1.6);
		expect(base.width).toBeCloseTo((VEIL.baseKm * 0.92) / 0.23, 6);
		expect(base.width).toBeGreaterThan(top.width);
		expect(base.light).toBeLessThan(top.light);
		// Spread, a veiled channel keeps the same light over its width.
		expect(base.light * base.width).toBeCloseTo((1 - 0.92 * (1 - VEIL.level)) * 1.6, 6);
		expect(cloudVeil(0.92, 9, 3, 1.6).width).toBe(1.6);
	});
});
