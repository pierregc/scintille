import { describe, expect, it } from 'vitest';
import { clampDistance, clipPlanes, rescaleDistance, rotateSpeedFor, zoomLimits } from './orbit';
import { fitDistance } from './viewport';

describe('zoomLimits', () => {
	it.each([16 / 9, 1, 9 / 16, 9 / 21])('keeps the fitted view within bounds at aspect %s', (aspect) => {
		const limits = zoomLimits(1, 35, aspect);
		expect(limits.fit).toBe(fitDistance(1, 35, aspect));
		expect(limits.min).toBeLessThanOrEqual(limits.fit);
		expect(limits.max).toBeGreaterThanOrEqual(limits.fit);
	});

	it('scales with the globe radius', () => {
		const small = zoomLimits(1, 35, 1);
		const big = zoomLimits(2, 35, 1);
		expect(big.min).toBeCloseTo(2 * small.min, 6);
		expect(big.max).toBeCloseTo(2 * small.max, 6);
	});
});

describe('clipPlanes', () => {
	const km = (value: number) => value / 6371;
	const shells = [1 + km(10), 1 + km(12), 1 + km(150)];
	const horizon = (distance: number) => Math.sqrt(distance * distance - 1) + Math.sqrt(shells[2] ** 2 - 1);

	it.each([4, 1.2, 1 + km(250), 1 + km(65), 1 + km(11), 1 + km(3)])('keeps every shell between the planes at %s', (distance) => {
		const { near, far } = clipPlanes(distance, 1, shells);
		for (const r of [1, ...shells]) {
			if (distance > r) expect(distance - r).toBeGreaterThan(near);
			else expect(r - distance).toBeGreaterThan(near);
		}
		expect(far).toBeGreaterThan(horizon(distance));
		expect(far).toBeLessThan(horizon(distance) * 1.05);
	});

	it('brings the near plane closer as the camera descends', () => {
		const high = clipPlanes(1 + km(20_000), 1, shells);
		const low = clipPlanes(1 + km(250), 1, shells);
		expect(low.near).toBeLessThan(km(70));
		expect(low.near).toBeLessThan(high.near / 100);
	});

	it('keeps depth precision at the closest tilted view', () => {
		const { near, far } = clipPlanes(1 + km(65), 1, shells);
		expect(far / near).toBeLessThan(1000);
	});

	it('keeps a floor when the camera sits on a shell', () => {
		const { near, far } = clipPlanes(shells[0], 1, shells);
		expect(near).toBeGreaterThan(0);
		expect(far).toBeGreaterThan(near);
	});

	it('scales with the globe radius', () => {
		const small = clipPlanes(4, 1, shells);
		const big = clipPlanes(8, 2, shells.map((r) => 2 * r));
		expect(big.near).toBeCloseTo(2 * small.near, 9);
		expect(big.far).toBeCloseTo(2 * small.far, 9);
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
