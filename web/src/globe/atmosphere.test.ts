import { describe, expect, it } from 'vitest';
import { atmosphereParameters, EARTH_ATMOSPHERE } from './atmosphere';
import { zoomLimits } from './orbit';

describe('atmosphereParameters', () => {
	it('keeps the vertical optical depth of the real atmosphere whatever the height scale', () => {
		const real = EARTH_ATMOSPHERE.rayleighScattering[2] * EARTH_ATMOSPHERE.rayleighHeight;
		for (const scale of [1, 2.5, 4]) {
			const p = atmosphereParameters(1, scale);
			expect(p.rayleighScattering.z * p.rayleighHeight).toBeCloseTo(real, 6);
		}
	});

	it('scales with the globe radius', () => {
		const one = atmosphereParameters(1);
		const two = atmosphereParameters(2);
		expect(two.atmosphereRadius).toBeCloseTo(2 * one.atmosphereRadius, 9);
		expect(two.rayleighScattering.x).toBeCloseTo(one.rayleighScattering.x / 2, 9);
	});

	it('stays a thin shell the camera never enters', () => {
		const { atmosphereRadius } = atmosphereParameters(1);
		expect(atmosphereRadius).toBeGreaterThan(1);
		expect(atmosphereRadius).toBeLessThan(1.05);
		for (const aspect of [0.5, 1, 2]) {
			expect(zoomLimits(1, 35, aspect).min).toBeGreaterThan(atmosphereRadius);
		}
	});
});
