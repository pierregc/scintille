import { describe, expect, it } from 'vitest';
import { blendPair, easePosition, framePosition } from './timeline';

describe('cloud timeline', () => {
	const times = [0, 100, 300];

	it('places a time between the frames around it', () => {
		expect(framePosition(times, -5)).toBe(0);
		expect(framePosition(times, 50)).toBe(0.5);
		expect(framePosition(times, 200)).toBe(1.5);
		expect(framePosition(times, 999)).toBe(2);
		expect(framePosition([], 5)).toBeNaN();
	});

	it('is continuous across frame boundaries', () => {
		const before = blendPair(framePosition(times, 99.999), 3);
		const after = blendPair(framePosition(times, 100), 3);
		expect(before.b).toBe(after.a);
		expect(before.mix).toBeCloseTo(1, 3);
		expect(after.mix).toBe(0);
	});

	it('fades a newly arrived frame in over a second or two', () => {
		let p = 1;
		const steps: number[] = [];
		for (let i = 0; i < 120; i++) steps.push((p = easePosition(p, 2, 1 / 60)));
		expect(steps[0]).toBeGreaterThan(1);
		expect(steps[0]).toBeLessThan(1.05);
		expect(steps.at(-1)).toBeGreaterThan(1.75);
		expect(steps.every((v, i) => i === 0 || v >= steps[i - 1])).toBe(true);
	});

	it('snaps on seeks and on the first frame', () => {
		expect(easePosition(0, 4, 1 / 60)).toBe(4);
		expect(easePosition(Number.NaN, 1, 1 / 60)).toBe(1);
	});
});
