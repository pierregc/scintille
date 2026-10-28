import { describe, expect, it } from 'vitest';
import { TRACK_CURRENT_MS } from '../../globe/scene-time';
import { ageSuffix, cloudCaption, formatDate, formatTime, positionCaption, zoneLabel } from './format';

const PARIS = 'Europe/Paris';
const NEW_YORK = 'America/New_York';
const MIN = 60_000;

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
		expect(cloudCaption(true, t, true, null, PARIS)).toBe('Observed 20:00');
		expect(cloudCaption(true, t, true, t + 10 * MIN, PARIS)).toBe('Observed 20:00');
		expect(cloudCaption(true, null, false)).toBe('');
		expect(cloudCaption(true, null, true)).toBe('No cloud data');
		expect(cloudCaption(false, t, true)).toBe('');
	});

	it('gives an observation its age only when it is far from the scene', () => {
		const t = Date.UTC(2026, 6, 15, 18);
		expect(ageSuffix(t, t + 14 * MIN)).toBe('');
		expect(ageSuffix(t, t + 40 * MIN)).toBe(' · 40 min earlier');
		expect(ageSuffix(t, t - 20 * MIN)).toBe(' · 20 min later');
		expect(ageSuffix(t, t + 130 * MIN)).toBe(' · 2 h earlier');
		expect(cloudCaption(true, t, true, t + 70 * MIN, 'UTC')).toBe('Observed 18:00 · 1 h earlier');
	});

	it('captions the storm position, its age, or its absence', () => {
		const t = Date.UTC(2026, 6, 15, 18, 30);
		expect(positionCaption({ state: 'pending', time: null }, t)).toBe('');
		expect(positionCaption({ state: 'current', time: t }, t + 5 * MIN, 'UTC')).toBe('Position observed 18:30');
		expect(positionCaption({ state: 'current', time: t }, t + 45 * MIN, 'UTC')).toBe('Position observed 18:30 · 45 min earlier');
		expect(positionCaption({ state: 'lost', time: t }, t + TRACK_CURRENT_MS + MIN, 'UTC')).toBe('No position since 18:30');
	});
});
