import { describe, expect, it } from 'vitest';
import { glare } from './glare';
import { latLonToVector } from './sun';

const sun = latLonToVector(0, 0);

describe('glare', () => {
	it('is full in daylight near the ground', () => {
		expect(glare(latLonToVector(10, 20), sun, 400)).toBe(1);
	});

	it('is nothing at night or from the globe view', () => {
		expect(glare(latLonToVector(0, 120), sun, 400)).toBe(0);
		expect(glare(latLonToVector(0, 0), sun, 20_000)).toBe(0);
	});

	it('fades through dusk and while climbing', () => {
		const dusk = glare(latLonToVector(0, 85), sun, 400);
		const high = glare(latLonToVector(0, 0), sun, 8000);
		expect(dusk).toBeGreaterThan(0);
		expect(dusk).toBeLessThan(1);
		expect(high).toBeGreaterThan(0);
		expect(high).toBeLessThan(1);
	});
});
