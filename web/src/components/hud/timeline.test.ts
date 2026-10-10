import { describe, expect, it } from 'vitest';
import { DAY_MS, dayFraction, keyStep, parseDateInput, timeAtFraction, utcDayStart } from './timeline';

describe('timeline', () => {
	const t = Date.UTC(2026, 6, 15, 18, 0);

	it('places a time in its UTC day', () => {
		expect(utcDayStart(t)).toBe(Date.UTC(2026, 6, 15));
		expect(dayFraction(t)).toBe(0.75);
		expect(timeAtFraction(utcDayStart(t), 0.75)).toBe(t);
	});

	it('keeps scrubbing inside the day', () => {
		const day = utcDayStart(t);
		expect(timeAtFraction(day, -1)).toBe(day);
		expect(timeAtFraction(day, 2)).toBe(day + DAY_MS - 1);
	});

	it('steps 5 minutes, or an hour with Shift', () => {
		expect(keyStep('ArrowRight', false)).toBe(300_000);
		expect(keyStep('ArrowLeft', true)).toBe(-3_600_000);
		expect(keyStep('a', false)).toBe(0);
	});

	it('reads date inputs as UTC days', () => {
		expect(parseDateInput('2026-07-15')).toBe(Date.UTC(2026, 6, 15));
		expect(parseDateInput('')).toBeNull();
	});
});
