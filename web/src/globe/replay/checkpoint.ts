import type { ReplayLocation } from './url';

export interface FrameCheckpoint {
	slug: string;
	fov: number;
	aspect: number;
	view: NonNullable<ReplayLocation['view']>;
}

/** Only a verified final frame from this storm and viewport can skip a reload approach. */
export function readFrameCheckpoint(value: unknown, slug: string, fov: number, aspect: number): ReplayLocation['view'] {
	if (!value || typeof value !== 'object') return;
	const saved = value as Partial<FrameCheckpoint>;
	if (saved.slug !== slug || saved.fov !== fov || saved.aspect !== aspect || !saved.view) return;
	const { lat, lon, altitude, tilt } = saved.view;
	if (![lat, lon, altitude, tilt].every((x) => typeof x === 'number' && Number.isFinite(x))) return;
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || altitude < 20 || altitude > 200_000 || tilt < 0 || tilt > 80) return;
	return { lat, lon, altitude, tilt };
}
/** A publication update can change the storm bounds between visits. */
export function sameFrame(saved: ReplayLocation['view'], frame: NonNullable<ReplayLocation['view']>): boolean {
	return Boolean(saved && Math.abs(saved.lat - frame.lat) < 1e-5
		&& Math.abs(((saved.lon - frame.lon + 540) % 360) - 180) < 1e-5
		&& Math.abs(saved.altitude - frame.altitude) < 0.001 && Math.abs(saved.tilt - frame.tilt) < 0.001);
}
