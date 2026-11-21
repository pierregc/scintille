import { blendPair, framePosition } from '../clouds/timeline';

/** One fix: `[unix_s, lat, lon, wind_kt, r34_km, heading, speed_ms]`, nulls where the advisory gives none. */
export type Fix = readonly [number, number, number, number | null, number | null, number | null, number | null];

export interface Cyclone {
	id: string;
	name: string;
	/** Last letter of the storm number: L, E, C, W, A, B, S, P. */
	basin: string;
	agency: string;
	track: readonly Fix[];
	/** Still followed when the feed was written: its position may be carried past the last fix. */
	active: boolean;
}

export interface CycloneFeed {
	generatedAt: number;
	attribution: string;
	cyclones: Cyclone[];
}

export const CYCLONE_TIMING = {
	/** A fix is published about 3 h after its time and replaced 6 h later; past this a storm is lost. */
	carryMs: 12 * 3_600_000,
	/** Fixes further apart than this are two lives of a storm number, never joined. */
	maxGapMs: 24 * 3_600_000,
} as const;

const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

export function parseCycloneFeed(json: unknown): CycloneFeed {
	const feed = json as { generated_at?: unknown; attribution?: unknown; cyclones?: unknown } | null;
	const generatedAt = Date.parse(String(feed?.generated_at));
	if (!feed || !Array.isArray(feed.cyclones) || Number.isNaN(generatedAt)) throw new Error('cyclones: invalid feed');
	const cyclones = feed.cyclones.map((entry: unknown): Cyclone => {
		const c = entry as Record<string, unknown>;
		const track = c.track;
		if (typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.basin !== 'string' || !Array.isArray(track) || track.length === 0) {
			throw new Error('cyclones: invalid storm');
		}
		for (const row of track as unknown[]) {
			if (!Array.isArray(row) || row.length !== 7 || !row.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))) {
				throw new Error('cyclones: invalid fix');
			}
		}
		const fixes = track as Fix[];
		return {
			id: c.id,
			name: c.name,
			basin: c.basin,
			agency: typeof c.agency === 'string' ? c.agency : '',
			track: fixes,
			active: generatedAt - fixes[fixes.length - 1][0] * 1000 <= CYCLONE_TIMING.carryMs,
		};
	});
	return { generatedAt, attribution: typeof feed.attribution === 'string' ? feed.attribution : '', cyclones };
}

export interface CycloneSample {
	lat: number;
	lon: number;
	windKt: number | null;
	r34Km: number | null;
	/** Time of the last fix at or before the sample, UTC ms. */
	fixTime: number;
	/** Carried along the last heading past the last fix. */
	carried: boolean;
}

function unit(lat: number, lon: number): [number, number, number] {
	return [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
}

function between(a: Fix, b: Fix, f: number): { lat: number; lon: number } {
	const p = unit(a[1], a[2]);
	const q = unit(b[1], b[2]);
	const v = p.map((x, i) => x + (q[i] - x) * f);
	const n = Math.hypot(v[0], v[1], v[2]);
	return { lat: Math.asin(v[2] / n) / RAD, lon: Math.atan2(v[1], v[0]) / RAD };
}

function mix(a: number | null, b: number | null, f: number): number | null {
	return a === null ? b : b === null ? a : a + (b - a) * f;
}

/** Where a cyclone is at `time` (UTC ms): between its fixes, or carried past the last one while it is active. */
export function sampleCyclone(cyclone: Cyclone, time: number): CycloneSample | null {
	const { track } = cyclone;
	const t = time / 1000;
	if (t < track[0][0]) return null;
	const last = track[track.length - 1];
	if (t >= last[0]) {
		const ageMs = (t - last[0]) * 1000;
		if (ageMs > 0 && (!cyclone.active || ageMs > CYCLONE_TIMING.carryMs)) return null;
		const km = ((last[6] ?? 0) * ageMs) / 1e6;
		const heading = (last[5] ?? 0) * RAD;
		const lat = last[1] + ((km * Math.cos(heading)) / EARTH_RADIUS_KM) / RAD;
		const lon = last[2] + ((km * Math.sin(heading)) / (EARTH_RADIUS_KM * Math.max(Math.cos(last[1] * RAD), 0.2))) / RAD;
		return { lat, lon: ((lon + 540) % 360) - 180, windKt: last[3], r34Km: last[4], fixTime: last[0] * 1000, carried: km > 0 };
	}
	let i = 0;
	while (track[i + 1][0] <= t) i++;
	const a = track[i];
	const b = track[i + 1];
	if ((b[0] - a[0]) * 1000 > CYCLONE_TIMING.maxGapMs) return null;
	const f = (t - a[0]) / (b[0] - a[0]);
	return { ...between(a, b, f), windKt: mix(a[3], b[3], f), r34Km: mix(a[4], b[4], f), fixTime: a[0] * 1000, carried: false };
}

/** Time the cloud layer shows for a scene time: cyclones are placed at it, so they sit on their clouds. */
export function cloudTime(sceneTime: number, frameTimes: readonly number[]): number {
	if (frameTimes.length === 0) return sceneTime;
	const { a, b, mix: share } = blendPair(framePosition(frameTimes, sceneTime), frameTimes.length);
	return frameTimes[a] + (frameTimes[b] - frameTimes[a]) * share;
}

const KIND: Record<string, string> = { L: 'Hurricane', E: 'Hurricane', C: 'Hurricane', W: 'Typhoon' };

/** What the storm is called at this wind, by basin; one-minute sustained winds (NHC, CPHC, JTWC). */
export function cycloneKind(basin: string, windKt: number | null): string {
	if (windKt === null) return 'Tropical cyclone';
	if (windKt < 34) return 'Tropical depression';
	if (windKt < 64) return 'Tropical storm';
	return KIND[basin] ?? 'Cyclone';
}

/** Wind in km/h, to the nearest 5. */
export function windKmh(windKt: number): number {
	return Math.round((windKt * 1.852) / 5) * 5;
}
