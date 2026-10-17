import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail, StormTrackPoint } from '../../contract/types';
import { latLonToVector } from '../sun';
import { StormTrack, trackCaption, trackGeometry, TRACK_MAX_GAP_MS } from './track';

const sample = (time: number, lat: number, lon: number): StormTrackPoint => ({ time: new Date(time).toISOString(), lat, lon, flash_count: 10, area_km2: 10 });

it('reveals only observed points and complete connectors, and rewinds without reallocating', () => {
	const track = new StormTrack();
	const detail = { ...fixture, track: [sample(0, 10, 10), sample(60_000, 11, 11), sample(120_000, 12, 12)] } as StormDetail;
	track.setStorm(detail);
	const [line, points] = track.group.children;
	if (!('geometry' in line) || !('geometry' in points)) throw new Error('missing track geometry');
	const geometry = line.geometry as import('three').BufferGeometry;
	const dots = points.geometry as import('three').BufferGeometry;
	track.setTime(59_999);
	expect(geometry.drawRange.count).toBe(0);
	expect(dots.drawRange.count).toBe(1);
	track.setTime(120_000);
	const full = geometry.drawRange.count;
	expect(full).toBeGreaterThan(2);
	track.setTime(60_000);
	expect(geometry.drawRange.count).toBeLessThan(full);
	expect(dots.drawRange.count).toBe(2);
	expect(line.geometry).toBe(geometry);
	track.setTime(-1);
	expect(track.group.visible).toBe(false);
	track.dispose();
});

describe('spherical paths', () => {
	it.each([[0, 179, 0, -179], [89, -90, 89, 90]])('tessellates short arcs at the dateline and pole (%s,%s,%s,%s)', (lat1, lon1, lat2, lon2) => {
		const geometry = trackGeometry([sample(0, lat1, lon1), sample(60_000, lat2, lon2)], 1);
		for (let i = 0; i < geometry.positions.length; i += 3) {
			const point = new Vector3(...geometry.positions.slice(i, i + 3));
			expect(point.length()).toBeCloseTo(1, 10);
			expect(point.angleTo(new Vector3(...latLonToVector(lat1, lon1)))).toBeLessThan(0.05);
		}
	});
	it('leaves long temporal gaps and ambiguous opposite points disconnected', () => {
		expect(trackGeometry([sample(0, 0, 0), sample(TRACK_MAX_GAP_MS + 1, 0, 1)], 1).positions).toHaveLength(0);
		expect(trackGeometry([sample(0, 0, 0), sample(1, 0, 180)], 1).positions).toHaveLength(0);
	});
	it('keeps a single published observation and labels the whole-storm level honestly', () => {
		const geometry = trackGeometry(fixture.track, 1);
		expect(geometry.positions).toHaveLength(0);
		expect(geometry.observations).toHaveLength(3);
		expect(geometry.times).toEqual([Date.parse(fixture.track[0].time)]);
		expect(trackCaption(fixture as StormDetail)).toContain('(whole storm)');
	});
	it('releases geometries on reselection and removes everything on leaving replay', () => {
		const track = new StormTrack();
		track.setStorm(fixture as StormDetail);
		const line = track.group.children[0] as import('three').LineSegments;
		const dispose = vi.spyOn(line.geometry, 'dispose');
		track.setStorm({ ...fixture, storm: { ...fixture.storm, slug: 'another' } } as StormDetail);
		expect(dispose).toHaveBeenCalledOnce();
		track.setTime(Infinity);
		expect(track.group.visible).toBe(true);
		track.setStorm(null);
		track.setTime(Infinity);
		expect(track.group.visible).toBe(false);
		const materialDispose = vi.spyOn(line.material as import('three').Material, 'dispose');
		track.dispose();
		expect(materialDispose).toHaveBeenCalledOnce();
		expect(track.group.children).toHaveLength(0);
	});
});
