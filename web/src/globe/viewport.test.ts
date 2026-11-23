import { describe, expect, it } from 'vitest';
import { budgetPixelRatio, cappedPixelRatio, fitDistance } from './viewport';

describe('cappedPixelRatio', () => {
	it.each([
		[1, 1],
		[1.5, 1.5],
		[2, 2],
		[3, 2],
	])('caps %s to %s', (dpr, expected) => {
		expect(cappedPixelRatio(dpr)).toBe(expected);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('falls back to 1 for %s', (dpr) => {
		expect(cappedPixelRatio(dpr)).toBe(1);
	});
});

describe('budgetPixelRatio', () => {
	it('keeps the capped ratio within the budget', () => {
		expect(budgetPixelRatio(2, 2, 1440, 900, 9)).toBe(2);
		expect(budgetPixelRatio(1.25, 1.5, 1536, 864, 3.5)).toBe(1.25);
	});

	it('lowers dense or large screens to the budget', () => {
		const ratio = budgetPixelRatio(1.5, 1.5, 2560, 1440, 3.5);
		expect(2560 * 1440 * ratio * ratio).toBeCloseTo(3.5e6, -3);
		expect(budgetPixelRatio(1, 1, 2560, 1440, 1.5)).toBeCloseTo(Math.sqrt(1.5e6 / (2560 * 1440)));
	});

	it('never draws under half the CSS size', () => {
		expect(budgetPixelRatio(1, 1, 3840, 2160, 1.5)).toBe(0.5);
	});
});

describe('fitDistance', () => {
	const halfAngleDeg = (radius: number, distance: number) => (Math.asin(radius / distance) * 180) / Math.PI;

	it('fits the vertical field of view in landscape', () => {
		const d = fitDistance(1, 40, 16 / 9, 1);
		expect(halfAngleDeg(1, d)).toBeCloseTo(20, 6);
	});

	it('fits the narrower horizontal field of view in portrait', () => {
		const aspect = 9 / 16;
		const d = fitDistance(1, 40, aspect, 1);
		const halfH = (Math.atan(Math.tan((20 * Math.PI) / 180) * aspect) * 180) / Math.PI;
		expect(halfAngleDeg(1, d)).toBeCloseTo(halfH, 6);
	});

	it('moves the camera back with a larger margin', () => {
		expect(fitDistance(1, 40, 1, 1.2)).toBeGreaterThan(fitDistance(1, 40, 1, 1));
	});
});
