import type { ActiveCell, Source, StormBounds, StormDetail } from '../../contract/types';
import { TRACK_CURRENT_MS, type TrackState } from '../scene-time';

export interface FocusPoint {
	time: number;
	lat: number;
	lon: number;
	/** Equivalent radius of the observed footprint, km, when known. */
	radiusKm: number | null;
}

/** An outline on the ground: the observed hull, or a circle of the observed area where only that is kept. */
export type Footprint =
	| { kind: 'hull'; ring: readonly (readonly number[])[] }
	| { kind: 'disc'; lat: number; lon: number; radiusKm: number };

export interface Observation {
	state: TrackState;
	/** Latest observed position at or before the time, never interpolated. */
	point: FocusPoint | null;
	/** The observed position before it, for the direction of motion. */
	previous: FocusPoint | null;
}

/** A storm the camera can frame and follow: an open replay or a live cell. */
export interface FocusSubject {
	readonly kind: 'replay' | 'live';
	readonly id: string;
	readonly level: number;
	readonly sources: readonly Source[];
	readonly points: readonly FocusPoint[];
	readonly bounds: StormBounds;
	footprint(observation: Observation): Footprint | null;
}

const radius = (areaKm2: number) => (areaKm2 > 0 ? Math.sqrt(areaKm2 / Math.PI) : null);

/** Same rule as `trackObservation`: the latest point at or before `time`, current for 90 minutes. */
export function observe({ points }: Pick<FocusSubject, 'points'>, time: number): Observation {
	let index = -1;
	while (index + 1 < points.length && points[index + 1].time <= time) index++;
	if (index < 0) return { state: 'pending', point: null, previous: null };
	const point = points[index];
	return { state: time - point.time <= TRACK_CURRENT_MS ? 'current' : 'lost', point, previous: points[index - 1] ?? null };
}

/** The catalog keeps one centroid and area per hourly window, not the cell outline. */
export function replaySubject(detail: StormDetail): FocusSubject {
	const points = detail.track
		.map((p) => ({ time: Date.parse(p.time), lat: p.lat, lon: p.lon, radiusKm: radius(p.area_km2) }))
		.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.lat) && Number.isFinite(p.lon))
		.sort((a, b) => a.time - b.time);
	return {
		kind: 'replay',
		id: detail.storm.slug,
		level: detail.storm.level,
		sources: detail.storm.sources,
		points,
		bounds: detail.bounds,
		footprint: ({ state, point }) => state === 'current' && point?.radiusKm
			? { kind: 'disc', lat: point.lat, lon: point.lon, radiusKm: point.radiusKm } : null,
	};
}

/** The feed keeps 10 minute centroids and the hull of the current cell. */
export function liveSubject(cell: ActiveCell): FocusSubject {
	const cellRadius = radius(cell.area_km2);
	const path = cell.path
		.map((p) => ({ time: Date.parse(p.time), lat: p.lat, lon: p.lon, radiusKm: cellRadius }))
		.sort((a, b) => a.time - b.time);
	const points = path.length ? path : [{ time: Date.parse(cell.t_end), lat: cell.lat, lon: cell.lon, radiusKm: cellRadius }];
	return {
		kind: 'live',
		id: cell.id,
		level: cell.level,
		sources: cell.sources,
		points,
		bounds: cell.bounds,
		footprint: ({ state }) => state === 'current' && cell.hull.length >= 4 ? { kind: 'hull', ring: cell.hull } : null,
	};
}
