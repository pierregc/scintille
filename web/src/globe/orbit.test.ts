import { describe, expect, it } from 'vitest';
import { clampDistance, rescaleDistance, rotateSpeedFor, zoomLimits } from './orbit';
import { fitDistance } from './viewport';

const NEAR = 0.1;
const FAR = 100;

describe('zoomLimits', () => {
	it.each([16 / 9, 1, 9 / 16, 9 / 21])('keeps the fitted view within bounds at aspect %s', (aspect) => {
		const limits = zoomLimits(1, 35, aspect, NEAR, FAR);
		expect(limits.fit).toBe(fitDistance(1, 35, aspect));
		expect(limits.min).toBeLessThanOrEqual(limits.fit);
		expect(limits.max).toBeGreaterThanOrEqual(limits.fit);
	});

	it('never lets the near plane reach the globe', () => {
		const { min } = zoomLimits(1, 35, 16 / 9, NEAR, FAR);
		expect(min - 1).toBeGreaterThan(NEAR);
	});

	it('keeps the globe in front of the far plane', () => {
		const { max } = zoomLimits(1, 35, 1, NEAR, 8);
		expect(max + 1).toBeLessThanOrEqual(8);
	});

	it('scales with the globe radius', () => {
		const small = zoomLimits(1, 35, 1, NEAR, FAR);
		const big = zoomLimits(2, 35, 1, NEAR, FAR);
		expect(big.min).toBeCloseTo(2 * small.min, 6);
		expect(big.max).toBeCloseTo(2 * small.max, 6);
	});
});

describe('clampDistance', () => {
	const limits = { min: 1.2, max: 8, fit: 4 };

	it.each([
		[0, 1.2],
		[0.5, 1.2],
		[3, 3],
		[100, 8],
		[Number.POSITIVE_INFINITY, 8],
		[Number.NaN, 8],
	])('clamps %s to %s', (distance, expected) => {
		expect(clampDistance(distance, limits)).toBe(expected);
	});
});

describe('rescaleDistance', () => {
	it('keeps the relative zoom across a resize', () => {
		const before = { min: 1.2, max: 8, fit: 4 };
		const after = { min: 1.2, max: 12, fit: 6 };
		expect(rescaleDistance(2, before, after)).toBe(3);
	});

	it('clamps to the new limits', () => {
		const before = { min: 1.2, max: 8, fit: 4 };
		const after = { min: 1.2, max: 4, fit: 2 };
		expect(rescaleDistance(1.3, before, after)).toBe(1.2);
	});
});

describe('rotateSpeedFor', () => {
	it('is slower close to the surface', () => {
		expect(rotateSpeedFor(1.3, 1, 4)).toBeLessThan(rotateSpeedFor(4, 1, 4));
	});

	it('stays positive and bounded', () => {
		expect(rotateSpeedFor(1, 1, 4)).toBeGreaterThan(0);
		expect(rotateSpeedFor(100, 1, 4)).toBe(rotateSpeedFor(10, 1, 4));
	});
});
