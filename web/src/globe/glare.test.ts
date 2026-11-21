import { describe, expect, it } from 'vitest';
import { glare, groundAlong } from './glare';
import { latLonToVector } from './sun';

const sun = latLonToVector(0, 0);

describe('glare', () => {
	it('is full in daylight near the ground', () => {
		expect(glare(latLonToVector(10, 20), sun, 400)).toBe(1);
	});

	it('is nothing at night or from the globe view', () => {
		expect(glare(latLonToVector(0, 120), sun, 400)).toBe(0);
		expect(glare(latLonToVector(0, 0), sun, 30_000)).toBe(0);
	});

	it('fades through dusk and while climbing', () => {
		const dusk = glare(latLonToVector(0, 85), sun, 400);
		const high = glare(latLonToVector(0, 0), sun, 12_000);
		expect(dusk).toBeGreaterThan(0);
		expect(dusk).toBeLessThan(1);
		expect(high).toBeGreaterThan(0);
		expect(high).toBeLessThan(1);
	});

	it('follows the ground behind the HUD rather than under the camera', () => {
		const dawn = latLonToVector(0, 95);
		expect(glare(dawn, sun, 2500)).toBe(0);
		expect(glare(dawn, sun, 2500, [dawn, latLonToVector(0, 75)])).toBe(1);
	});

	it('finds the ground along a ray, or the limb when it misses', () => {
		expect(groundAlong([3, 0, 0], [-1, 0, 0], 1)).toEqual([1, 0, 0]);
		expect(groundAlong([3, 0, 0], [0, 1, 0], 1)).toEqual([3, 0, 0]);
	});
});
