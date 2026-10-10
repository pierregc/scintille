import { describe, expect, it } from 'vitest';
import { latLonToVector, type Vec3 } from '../sun';
import { distanceKm, EARTH_RADIUS_KM, facesCamera, MAX_DELAY_S, STYLIZED_KM_PER_S, voicing } from './spatial';

describe('facesCamera', () => {
	const camera: Vec3 = [3, 0, 0];
	it('keeps flashes on the visible side of the globe', () => {
		expect(facesCamera(latLonToVector(0, 0), camera, 1)).toBe(true);
		expect(facesCamera(latLonToVector(0, 80), camera, 1)).toBe(false);
		expect(facesCamera(latLonToVector(0, 180), camera, 1)).toBe(false);
	});
});

describe('distanceKm', () => {
	it('measures from the camera to the flash on the surface', () => {
		expect(distanceKm(latLonToVector(0, 0), [2, 0, 0], 1)).toBeCloseTo(EARTH_RADIUS_KM);
		expect(distanceKm(latLonToVector(0, 0), [4, 0, 0], 2)).toBeCloseTo(EARTH_RADIUS_KM);
	});
});

describe('voicing', () => {
	it('gets louder, brighter and sooner as the camera comes closer', () => {
		const far = voicing(0.5, 15_000, 0);
		const near = voicing(0.5, 500, 0);
		expect(near.gain).toBeGreaterThan(far.gain * 3);
		expect(near.cutoff).toBeGreaterThan(far.cutoff);
		expect(near.delay).toBeLessThan(far.delay);
	});

	it('uses a stylized speed of sound, capped', () => {
		expect(voicing(1, 3000, 0).delay).toBeCloseTo(3000 / STYLIZED_KM_PER_S);
		expect(voicing(1, 1e6, 0).delay).toBe(MAX_DELAY_S);
		expect(voicing(1, 0, 0).delay).toBe(0);
	});

	it('scales with intensity and stays within [0, 1]', () => {
		expect(voicing(1, 1000, 0).gain).toBeGreaterThan(voicing(0, 1000, 0).gain);
		expect(voicing(1, 0, 0).gain).toBeLessThanOrEqual(1);
		expect(voicing(0, 1e6, 0).gain).toBeGreaterThan(0);
	});

	it('pans with the screen position', () => {
		expect(voicing(1, 1000, -1).pan).toBeLessThan(0);
		expect(voicing(1, 1000, 1).pan).toBeGreaterThan(0);
		expect(voicing(1, 1000, 0).pan).toBe(0);
		expect(Math.abs(voicing(1, 1000, 5).pan)).toBeLessThanOrEqual(1);
	});
});
