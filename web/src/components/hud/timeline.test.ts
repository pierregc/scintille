import { describe, expect, it } from 'vitest';
import { DAY_MS, dateInputValue, dayLength, dayStart, keyStep, parseDateInput, scaleMarks, scaleWindow, timeAtFraction, windowFraction } from './timeline';

const PARIS = 'Europe/Paris';
const NEW_YORK = 'America/New_York';
const HOUR = 3_600_000;

describe('timeline', () => {
	const t = Date.UTC(2026, 6, 15, 16, 0);

	it('shows the last 24 hours up to now, across midnight', () => {
		const now = Date.UTC(2026, 6, 15, 4, 30);
		const w = scaleWindow(now - 6 * HOUR, now, PARIS);
		expect(w).toEqual({ start: now - DAY_MS, end: now, recent: true });
		expect(windowFraction(w, now - 6 * HOUR)).toBe(0.75);
		expect(timeAtFraction(w, 2)).toBe(now);
		expect(timeAtFraction(w, -1)).toBe(now - DAY_MS);
	});

	it('shows an older local day, kept inside that day', () => {
		const w = scaleWindow(t, t + 3 * DAY_MS, PARIS);
		expect(w).toEqual({ start: Date.UTC(2026, 6, 14, 22), end: Date.UTC(2026, 6, 15, 22), recent: false });
		expect(windowFraction(w, t)).toBe(0.75);
		expect(timeAtFraction(w, 0.75)).toBe(t);
		expect(timeAtFraction(w, 2)).toBe(w.end - 1);
		expect(scaleWindow(t, t + 3 * DAY_MS, NEW_YORK).start).toBe(Date.UTC(2026, 6, 15, 4));
	});

	it('labels local hours, and now at the right end', () => {
		const now = Date.UTC(2026, 6, 15, 4, 40);
		const recent = scaleMarks(scaleWindow(now, now, PARIS), PARIS);
		expect(recent.ticks).toHaveLength(48);
		expect(recent.labels.map((l) => l.text)).toEqual(['12', '18', '00', 'now']);
		expect(recent.labels[0].at).toBeCloseTo((5 + 1 / 3) / 24);
		const day = scaleMarks(scaleWindow(t, t + 3 * DAY_MS, PARIS), PARIS);
		expect(day.labels.map((l) => l.text)).toEqual(['00', '06', '12', '18', '24']);
		expect(day.ticks).toHaveLength(49);
	});

	it('spans 23 or 25 hours on daylight saving days', () => {
		const spring = dayStart(Date.UTC(2026, 2, 29, 12), PARIS);
		expect(spring).toBe(Date.UTC(2026, 2, 28, 23));
		expect(dayLength(spring, PARIS)).toBe(23 * HOUR);
		const fall = dayStart(Date.UTC(2026, 10, 1, 12), NEW_YORK);
		expect(fall).toBe(Date.UTC(2026, 10, 1, 4));
		expect(dayLength(fall, NEW_YORK)).toBe(25 * HOUR);
		expect(timeAtFraction(scaleWindow(fall, fall + 3 * DAY_MS, NEW_YORK), 2)).toBe(fall + 25 * HOUR - 1);
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
