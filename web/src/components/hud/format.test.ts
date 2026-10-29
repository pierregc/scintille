import { describe, expect, it } from 'vitest';
import { TRACK_CURRENT_MS } from '../../globe/scene-time';
import s1 from '../../../../fixtures/storms/active/1.json';
import type { ActiveCell } from '../../contract/types';
import type { LiveSelection } from '../../globe/focus';
import { ACTIVE_STALE_MS } from '../../globe/focus/active';
import { ageSuffix, cloudCaption, endedCaption, formatDate, formatTime, liveCaption, positionCaption, zoneLabel } from './format';

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

describe('storm captions', () => {
	const cell = { ...(s1.cells.find((c) => c.id === 'synthetic-tampa') as ActiveCell), name: 'Tampa' };
	const publishedAt = Date.parse(s1.published_at);
	const live: LiveSelection = { id: cell.id, cell, merged: null, end: null, splits: [], publishedAt };
	const point = { time: Date.parse('2026-07-15T18:31:00Z'), lat: 0, lon: 0, radiusKm: 10 };
	const observation = { state: 'current' as const, point, previous: null };
	const observed = Date.parse('2026-07-15T18:34:00Z');
	const caption = (selection: LiveSelection, wall = publishedAt) => liveCaption({ live: selection, observation, observed }, wall, 'UTC');

	it('names a live storm, its level and where it was last seen', () => {
		expect(caption(live)).toEqual(['Tampa · Intense electrical activity so far', 'Position observed 18:31']);
		expect(caption({ ...live, cell: { ...cell, name: null, level: 2 } })[0]).toBe('Storm · Moderate electrical activity so far');
		expect(liveCaption({ live: null, observation, observed }, publishedAt)).toEqual([]);
	});

	it('explains merges, splits, ends and late updates', () => {
		expect(caption({ ...live, merged: { name: 'Lakeland', at: Date.parse('2026-07-15T18:44:10Z') } })).toContain('Lakeland merged into it at 18:44');
		expect(caption({ ...live, splits: [cell] })).toContain('A cell split off');
		expect(caption({ ...live, splits: [cell, cell] })).toContain('2 cells split off');
		expect(caption({ ...live, end: { reason: 'expired', tEnd: Date.parse('2026-07-15T18:41:02Z') } })[1]).toBe('Ended · last flash 18:41');
		expect(caption({ ...live, end: { reason: 'source-gap', tEnd: Date.parse('2026-07-15T18:29:40Z') } })[1]).toBe('No data from GLM East since 18:29');
		expect(caption({ ...live, end: { reason: 'lost', tEnd: null } })[1]).toBe('No longer tracked');
		expect(caption(live, publishedAt + ACTIVE_STALE_MS + 1).at(-1)).toBe('Updates delayed since 18:36');
		expect(caption(live, publishedAt + ACTIVE_STALE_MS)).toHaveLength(2);
	});

	it('marks the end of a closed replay storm once the scene passes its last flash', () => {
		const storm = { t_end: '2026-10-19T05:22:58Z', closed: true };
		expect(endedCaption(storm, Date.parse('2026-10-19T05:22:00Z'), 'UTC')).toBe('');
		expect(endedCaption(storm, Date.parse('2026-10-19T05:30:00Z'), 'UTC')).toBe('Ended · last flash 05:22');
		expect(endedCaption({ ...storm, closed: false }, Date.parse('2026-10-19T05:30:00Z'), 'UTC')).toBe('');
	});
});
