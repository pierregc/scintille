import { describe, expect, it } from 'vitest';
import { cloudCaption, formatDate, formatTime, zoneLabel } from './format';

const PARIS = 'Europe/Paris';
const NEW_YORK = 'America/New_York';

describe('HUD formatting', () => {
	it('shows the time and date of the zone', () => {
		const t = Date.UTC(2026, 6, 5, 3, 4, 9);
		expect(formatTime(t, PARIS)).toBe('05:04:09');
		expect(formatDate(t, PARIS)).toBe('05 Jul 2026');
		expect(formatTime(t, NEW_YORK)).toBe('23:04:09');
		expect(formatDate(t, NEW_YORK)).toBe('04 Jul 2026');
	});

	it('follows daylight saving time', () => {
		expect(formatTime(Date.UTC(2026, 9, 25, 0, 30), PARIS)).toBe('02:30:00');
		expect(formatTime(Date.UTC(2026, 9, 25, 1, 30), PARIS)).toBe('02:30:00');
		expect(formatTime(Date.UTC(2026, 9, 25, 2, 30), PARIS)).toBe('03:30:00');
	});

	it('names the zone by its city, or by its offset', () => {
		expect(zoneLabel(PARIS)).toBe('Paris');
		expect(zoneLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
		expect(zoneLabel('Etc/GMT-2')).toBe('UTC+2');
		expect(zoneLabel('UTC')).toMatch(/^UTC(\+0)?$/);
	});

	it('captions the cloud frame time, or its absence once the feed has answered', () => {
		const t = Date.UTC(2026, 6, 15, 18);
		expect(cloudCaption(true, t, true, PARIS)).toBe('Observed 20:00');
		expect(cloudCaption(true, null, false)).toBe('');
		expect(cloudCaption(true, null, true)).toBe('No cloud data');
		expect(cloudCaption(false, t, true)).toBe('');
	});
});
