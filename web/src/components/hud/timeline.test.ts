import { describe, expect, it } from 'vitest';
import { DAY_MS, dateInputValue, dayFraction, dayLength, dayStart, keyStep, parseDateInput, timeAtFraction } from './timeline';

const PARIS = 'Europe/Paris';
const NEW_YORK = 'America/New_York';
const HOUR = 3_600_000;

describe('timeline', () => {
	const t = Date.UTC(2026, 6, 15, 16, 0);

	it('places a time in its local day', () => {
		expect(dayStart(t, PARIS)).toBe(Date.UTC(2026, 6, 14, 22));
		expect(dayFraction(t, PARIS)).toBe(0.75);
		expect(timeAtFraction(dayStart(t, PARIS), 0.75, PARIS)).toBe(t);
		expect(dayStart(t, NEW_YORK)).toBe(Date.UTC(2026, 6, 15, 4));
		expect(dayFraction(t, NEW_YORK)).toBe(0.5);
	});

	it('keeps scrubbing inside the day', () => {
		const day = dayStart(t, PARIS);
		expect(timeAtFraction(day, -1, PARIS)).toBe(day);
		expect(timeAtFraction(day, 2, PARIS)).toBe(day + DAY_MS - 1);
	});

	it('spans 23 or 25 hours on daylight saving days', () => {
		const spring = dayStart(Date.UTC(2026, 2, 29, 12), PARIS);
		expect(spring).toBe(Date.UTC(2026, 2, 28, 23));
		expect(dayLength(spring, PARIS)).toBe(23 * HOUR);
		const fall = dayStart(Date.UTC(2026, 10, 1, 12), NEW_YORK);
		expect(fall).toBe(Date.UTC(2026, 10, 1, 4));
		expect(dayLength(fall, NEW_YORK)).toBe(25 * HOUR);
		expect(timeAtFraction(fall, 2, NEW_YORK)).toBe(fall + 25 * HOUR - 1);
	});

	it('steps 5 minutes, or an hour with Shift', () => {
		expect(keyStep('ArrowRight', false)).toBe(300_000);
		expect(keyStep('ArrowLeft', true)).toBe(-3_600_000);
		expect(keyStep('a', false)).toBe(0);
	});

	it('reads and writes date inputs as local days', () => {
		expect(parseDateInput('2026-07-15', PARIS)).toBe(Date.UTC(2026, 6, 14, 22));
		expect(parseDateInput('2026-07-15', NEW_YORK)).toBe(Date.UTC(2026, 6, 15, 4));
		expect(parseDateInput('')).toBeNull();
		expect(dateInputValue(Date.UTC(2026, 6, 15, 23), PARIS)).toBe('2026-07-16');
		expect(dateInputValue(Date.UTC(2026, 6, 15, 23), NEW_YORK)).toBe('2026-07-15');
	});
});
