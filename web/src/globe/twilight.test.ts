import { describe, expect, it } from 'vitest';
import { TWILIGHT_WEIGHTS, twilightLevel, twilightUniforms } from './twilight';

describe('twilightUniforms', () => {
	it('places band edges at the sine of 0, -6, -12 and -18 degrees', () => {
		const { edges } = twilightUniforms();
		const expected = [0, -6, -12, -18].map((d) => Math.sin((d * Math.PI) / 180));
		edges.forEach((edge, i) => expect(edge).toBeCloseTo(expected[i] ?? NaN, 12));
	});

	it('has weights summing to one', () => {
		expect(TWILIGHT_WEIGHTS.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
	});
});

describe('twilightLevel', () => {
	it('is full day above the horizon band and full night below astronomical twilight', () => {
		expect(twilightLevel(2)).toBe(1);
		expect(twilightLevel(45)).toBe(1);
		expect(twilightLevel(-20)).toBe(0);
		expect(twilightLevel(-90)).toBe(0);
	});

	it('holds a flat level inside each twilight band', () => {
		expect(twilightLevel(-3)).toBeCloseTo(0.5, 12);
		expect(twilightLevel(-9)).toBeCloseTo(0.25, 12);
		expect(twilightLevel(-15)).toBeCloseTo(0.1, 12);
	});

	it('sits halfway through each step at the band edges', () => {
		expect(twilightLevel(0)).toBeCloseTo(0.75, 12);
		expect(twilightLevel(-6)).toBeCloseTo(0.375, 12);
		expect(twilightLevel(-12)).toBeCloseTo(0.175, 12);
		expect(twilightLevel(-18)).toBeCloseTo(0.05, 12);
	});

	it('never decreases as the sun rises', () => {
		let previous = -1;
		for (let e = -30; e <= 10; e += 0.05) {
			const level = twilightLevel(e);
			expect(level).toBeGreaterThanOrEqual(previous - 1e-12);
			previous = level;
		}
	});
});
