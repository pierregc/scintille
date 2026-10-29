import { describe, expect, it } from 'vitest';
import { latLonToVector, type Vec3 } from '../sun';
import { distanceKm, EARTH_RADIUS_KM, facesCamera, MAX_AZIMUTH, MAX_ELEVATION, voicing } from './spatial';

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
	it('gets louder and brighter as the camera comes closer', () => {
		const far = voicing(0.5, 15_000, 0, 0);
		const near = voicing(0.5, 500, 0, 0);
		expect(near.gain).toBeGreaterThan(far.gain * 3);
		expect(near.cutoff).toBeGreaterThan(far.cutoff);
	});

	it('scales with intensity and stays within [0, 1]', () => {
		expect(voicing(1, 1000, 0, 0).gain).toBeGreaterThan(voicing(0, 1000, 0, 0).gain);
		expect(voicing(1, 0, 0, 0).gain).toBeLessThanOrEqual(1);
		expect(voicing(0, 1e6, 0, 0).gain).toBeGreaterThan(0);
	});

	it('places the screen centre ahead and its edges wide around the listener', () => {
		const ahead = voicing(1, 1000, 0, 0).position;
		expect(ahead[0]).toBeCloseTo(0);
		expect(ahead[1]).toBeCloseTo(0);
		expect(ahead[2]).toBeCloseTo(-1);
		const [x, y, z] = voicing(1, 1000, 1, 1).position;
		expect(Math.hypot(x, y, z)).toBeCloseTo(1);
		expect(Math.asin(y)).toBeCloseTo(MAX_ELEVATION);
		expect(Math.atan2(x, -z)).toBeCloseTo(MAX_AZIMUTH);
		expect(voicing(1, 1000, -1, -1).position[0]).toBeLessThan(0);
		expect(voicing(1, 1000, -1, -1).position[1]).toBeLessThan(0);
		expect(voicing(1, 1000, 5, 0).position[0]).toBeCloseTo(Math.sin(MAX_AZIMUTH));
	});
});
