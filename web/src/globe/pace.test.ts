import { describe, expect, it } from 'vitest';
import { FramePacer } from './pace';

const drawn = (pacer: FramePacer, hz: number, seconds = 2) => {
	let count = 0;
	for (let t = 0; t < seconds * 1000; t += 1000 / hz) if (pacer.due(t)) count++;
	return count / seconds;
};

describe('FramePacer', () => {
	it('keeps every frame of a 60 Hz screen, jitter included', () => {
		expect(drawn(new FramePacer(60), 60)).toBe(60);
		const pacer = new FramePacer(60);
		let count = 0;
		for (let i = 0; i < 120; i++) if (pacer.due(i * 16.667 + (i % 2 ? -1 : 1))) count++;
		expect(count).toBe(120);
	});

	it('caps faster screens near the target', () => {
		for (const hz of [90, 120, 144, 240]) expect(drawn(new FramePacer(60), hz)).toBeGreaterThanOrEqual(54);
		for (const hz of [90, 120, 144, 240]) expect(drawn(new FramePacer(60), hz)).toBeLessThanOrEqual(61);
	});

	it('follows a lower target', () => {
		expect(Math.abs(drawn(new FramePacer(30), 120) - 30)).toBeLessThanOrEqual(1);
		expect(drawn(new FramePacer(30), 60)).toBe(30);
	});
});
