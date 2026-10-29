import { describe, expect, it } from 'vitest';
import orlando from '../../../../fixtures/storms/2026-07-15-orlando.json';
import s1 from '../../../../fixtures/storms/active/1.json';
import type { ActiveCell, StormDetail } from '../../contract/types';
import { TRACK_CURRENT_MS } from '../scene-time';
import { liveSubject, observe, replaySubject } from './subject';

describe('focus subjects', () => {
	const detail = orlando as StormDetail;
	const replay = replaySubject(detail);
	const times = detail.track.map((p) => Date.parse(p.time)).sort((a, b) => a - b);

	it('shows the latest observed position at or before the scene time, never one after it', () => {
		expect(observe(replay, times[0] - 1)).toEqual({ state: 'pending', point: null, previous: null });
		const first = observe(replay, times[0]);
		expect(first.point?.time).toBe(times[0]);
		expect(first.previous).toBeNull();
		if (times.length > 1) {
			const between = observe(replay, (times[0] + times[1]) / 2);
			expect(between.point?.time).toBe(times[0]);
		}
		const last = times.at(-1) ?? 0;
		expect(observe(replay, last + TRACK_CURRENT_MS).state).toBe('current');
		expect(observe(replay, last + TRACK_CURRENT_MS + 1).state).toBe('lost');
	});

	it('draws a replay footprint as a circle of the observed area while the position is current', () => {
		const sample = detail.track[0];
		const observation = observe(replay, Date.parse(sample.time));
		expect(replay.footprint(observation)).toEqual({ kind: 'disc', lat: sample.lat, lon: sample.lon, radiusKm: Math.sqrt(sample.area_km2 / Math.PI) });
		expect(replay.footprint(observe(replay, (times.at(-1) ?? 0) + TRACK_CURRENT_MS + 1))).toBeNull();
	});

	it('follows a live cell on its 10 minute path and draws its hull', () => {
		const cell = s1.cells.find((c) => c.id === 'synthetic-tampa') as ActiveCell;
		const live = liveSubject(cell);
		expect(live.points.map((p) => p.time)).toEqual(cell.path.map((p) => Date.parse(p.time)));
		const observation = observe(live, Date.parse(cell.t_end));
		expect(observation.point?.time).toBe(Date.parse(cell.path.at(-1)?.time ?? ''));
		expect(observation.previous?.time).toBe(Date.parse(cell.path.at(-2)?.time ?? ''));
		expect(live.footprint(observation)).toEqual({ kind: 'hull', ring: cell.hull });
		const pathless = liveSubject({ ...cell, path: [] });
		expect(pathless.points).toEqual([{ time: Date.parse(cell.t_end), lat: cell.lat, lon: cell.lon, radiusKm: Math.sqrt(cell.area_km2 / Math.PI) }]);
	});
});
