import { describe, expect, it } from 'vitest';
import { FlashPlayback } from './playback';

describe('FlashPlayback', () => {
	it('turns scene age into wall clock age at the replay speed', () => {
		const playback = new FlashPlayback();
		playback.update(0, 60);
		expect(playback.age(0, 30_000)).toBeCloseTo(0.5);
		expect(playback.span(1, 30_000)).toBe(60_000);
	});

	it('lets lit flashes finish at their own pace when the speed changes during play', () => {
		const playback = new FlashPlayback();
		playback.update(100_000, 60);
		playback.update(100_016, 60);
		playback.update(100_032, 600);
		expect(playback.pivot).toBe(100_032);
		expect(playback.age(70_032, 100_032)).toBeCloseTo(0.5);
		expect(playback.age(70_032, 160_032)).toBeCloseTo(0.6);
		expect(playback.age(100_032, 160_032)).toBeCloseTo(0.1);
		expect(playback.span(1, 160_032)).toBeCloseTo(60_000 + 0.9 * 60_000);
		expect(playback.span(1, 800_000)).toBe(600_000);
	});

	it('starts afresh after a jump, such as a seek or a return to live', () => {
		const playback = new FlashPlayback();
		playback.update(100_000, 60);
		playback.update(9_000_000, 1);
		expect(playback.pivot).toBe(Number.NEGATIVE_INFINITY);
		expect(playback.age(8_999_000, 9_000_000)).toBeCloseTo(1);
		expect(playback.age(9_000_000, 50_000)).toBeLessThan(0);
	});

	it('rejects a stopped clock', () => {
		expect(() => new FlashPlayback().update(0, 0)).toThrow(RangeError);
	});
});
