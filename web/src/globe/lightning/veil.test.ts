import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../sun';
import { SKELETON } from './skeleton';
import { glslFloat } from './profile';
import { clearAirLight, cloudCrossing, cloudTransmission, cloudVeil, liftHeight, reliefLift, VEIL, veilGlsl } from './veil';

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
		expect(cloudVeil(0, 9, 0.23, 1.6, 1)).toEqual({ width: 1.6, light: 1 });
		const top = cloudVeil(0.92, SKELETON.cloudTopKm, 0.23, 1.6, 1);
		const base = cloudVeil(0.92, SKELETON.cloudBaseKm, 0.23, 1.6, 1);
		expect(base.width).toBeCloseTo((VEIL.baseKm * 0.92) / 0.23, 6);
		expect(base.width).toBeGreaterThan(top.width);
		expect(base.light).toBeLessThan(top.light);
		// Spread, a veiled channel keeps the same light over its width.
		expect(base.light * base.width).toBeCloseTo((1 - 0.92 * (1 - VEIL.level)) * 1.6, 6);
		expect(cloudVeil(0.92, 9, 3, 1.6, 1).width).toBe(1.6);
	});

	it('leaves the depth veil of in-cloud channels as it was', () => {
		for (const opacity of [0, 0.3, 0.6, 0.95]) {
			for (const height of [6, 7, 9, 11.5]) {
				for (const kmPerPx of [0.23, 0.6, 3]) {
					const depth = Math.min(1, Math.max(0, (SKELETON.cloudTopKm - height) / (SKELETON.cloudTopKm - SKELETON.cloudBaseKm)));
					const width = Math.max(1.6, ((VEIL.topKm + (VEIL.baseKm - VEIL.topKm) * depth) * opacity) / kmPerPx);
					const veiled = cloudVeil(opacity, height, kmPerPx, 1.6, 1);
					expect(veiled.width).toBeCloseTo(width, 9);
					expect(veiled.light).toBeCloseTo(((1 - opacity * (1 - VEIL.level)) * 1.6) / width, 9);
				}
			}
		}
	});

	it('keeps a trace of a channel below any cloud, whole in clear air', () => {
		expect(clearAirLight(0, 1)).toBe(1);
		expect(clearAirLight(0.95, 1)).toBe(VEIL.trace);
		expect(clearAirLight(0.95, 0.5)).toBe(VEIL.trace);
		expect(VEIL.trace).toBe(0.3);
		expect(clearAirLight(0.2, 1)).toBe(cloudTransmission(0.2, 1));
		for (let a = 0; a <= 1; a += 0.05) expect(clearAirLight(a, 0.3)).toBeGreaterThanOrEqual(0.3);
	});

	it('keeps an in-cloud trace crisp and lit through a thick cloud', () => {
		for (const height of [6, 7, 8.5, 10, 11.5]) {
			for (const kmPerPx of [0.23, 0.45, 1, 3]) {
				const veiled = cloudVeil(0.95, height, kmPerPx, 1.6, 2);
				expect(veiled.width).toBeLessThanOrEqual(2 * 1.6);
				expect(veiled.light).toBeGreaterThanOrEqual(0.3);
				expect(veiled.width).toBeLessThanOrEqual(cloudVeil(0.95, height, kmPerPx, 1.6, 1).width);
			}
		}
		expect(cloudVeil(0, 9, 0.23, 1.6, 2)).toEqual({ width: 1.6, light: 1 });
	});

	it('lifts channels under a low drawn top without moving a drop under the base', () => {
		expect(reliefLift(14)).toEqual([SKELETON.cloudBaseKm, 1, 1]);
		for (const top of [4, 6, 8, 8.9, 9, 10, 11, 12, 14]) {
			const lift = reliefLift(top);
			let previous = 0;
			for (let z = 0; z <= SKELETON.cloudTopKm + 1e-9; z += 0.25) {
				const drawn = liftHeight(z, lift);
				if (lift[2] === 1 && z <= SKELETON.cloudBaseKm) expect(drawn).toBe(z);
				expect(drawn).toBeLessThanOrEqual(z + 1e-9);
				expect(drawn).toBeGreaterThanOrEqual(previous);
				previous = drawn;
			}
			// Nothing rises over the drawn top, down to a top of 4 km.
			expect(liftHeight(SKELETON.cloudTopKm, lift)).toBeLessThanOrEqual(top - VEIL.reliefMargin + 1e-9);
		}
		// A top over 8.85 km keeps every drop at its height.
		expect(reliefLift(8.9)[2]).toBe(1);
	});

	it('writes the trace and the relief bounds into the shader twins', () => {
		for (const x of [VEIL.trace, VEIL.traceWidth, VEIL.reliefMargin, VEIL.reliefMin, SKELETON.cloudBaseKm]) expect(veilGlsl).toContain(glslFloat(x));
		expect(veilGlsl).toContain('float clearAirLight(float opacity, float slant)');
		expect(veilGlsl).toContain('vec2 cloudVeil(float opacity, float heightKm, float kmPerPx, float width, float flag)');
		expect(veilGlsl).toContain('vec3 liftPoint(vec3 p, vec3 lift)');
	});
});
