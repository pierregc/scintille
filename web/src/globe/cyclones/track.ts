import { CYCLONE_BASIN_VALUES, type CycloneBasin } from '../../contract/types';
import { blendPair, framePosition } from '../clouds/timeline';
import { CONTRACT_MAJOR } from '../live/decode';

/** One advisory position, times in UTC ms. */
export interface Fix {
	time: number;
	lat: number;
	lon: number;
	windKt: number | null;
	r34Km: number | null;
	heading: number | null;
	speedMs: number | null;
}

export interface Cyclone {
	id: string;
	name: string;
	basin: CycloneBasin;
	agency: string;
	/** Still followed by the advisories: only then may it be shown past its last fix. */
	active: boolean;
	fixes: Fix[];
}

export interface Cyclones {
	generatedAt: number;
	/** Latest advisory cycle read, UTC ms. */
	sourceCycle: number | null;
	attribution: string;
	cyclones: Cyclone[];
}

/** A fix comes out about 3 h after its time and is replaced 6 h later: past this, a storm is lost (ADR 0040). */
export const CARRY_MS = 12 * 3_600_000;
/** Fixes further apart than this are never joined. */
export const MAX_GAP_MS = 24 * 3_600_000;

const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optional = (value: unknown) => (finite(value) ? value : null);

function fix(value: unknown): Fix | null {
	if (!record(value) || !finite(value.lat) || !finite(value.lon) || Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180) return null;
	const time = Date.parse(String(value.time));
	if (Number.isNaN(time)) return null;
	return { time, lat: value.lat, lon: value.lon, windKt: optional(value.wind_kt), r34Km: optional(value.r34_km), heading: optional(value.heading), speedMs: optional(value.speed_ms) };
}

function cyclone(value: unknown): Cyclone | null {
	if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || !value.name ||
		!CYCLONE_BASIN_VALUES.includes(value.basin as never) || !Array.isArray(value.track)) return null;
	const fixes = value.track.map(fix).filter((f): f is Fix => f !== null).sort((a, b) => a.time - b.time);
	if (fixes.length === 0) return null;
	return { id: value.id, name: value.name, basin: value.basin as CycloneBasin, agency: typeof value.agency === 'string' ? value.agency : '', active: value.active === true, fixes };
}

/** Checks the envelope and drops malformed storms and fixes; the pipeline validates the full contract. */
export function parseCyclones(value: unknown): Cyclones {
	if (!record(value) || Number(String(value.schema_version).split('.')[0]) !== CONTRACT_MAJOR || !Array.isArray(value.cyclones)) {
		throw new Error('invalid cyclones feed');
	}
	const generatedAt = Date.parse(String(value.generated_at));
	if (Number.isNaN(generatedAt)) throw new Error('invalid cyclones feed');
	const cycle = Date.parse(String(value.source_cycle));
	return {
		generatedAt,
		sourceCycle: Number.isNaN(cycle) ? null : cycle,
		attribution: typeof value.attribution === 'string' ? value.attribution : '',
		cyclones: value.cyclones.map(cyclone).filter((c): c is Cyclone => c !== null),
	};
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
	const p = unit(a.lat, a.lon);
	const q = unit(b.lat, b.lon);
	const v = p.map((x, i) => x + (q[i] - x) * f);
	const n = Math.hypot(v[0], v[1], v[2]);
	return { lat: Math.asin(v[2] / n) / RAD, lon: Math.atan2(v[1], v[0]) / RAD };
}

function mix(a: number | null, b: number | null, f: number): number | null {
	return a === null ? b : b === null ? a : a + (b - a) * f;
}

/** Where a cyclone is at `time` (UTC ms): between its fixes, or carried past the last one while it is active. */
export function sampleCyclone({ fixes, active }: Cyclone, time: number): CycloneSample | null {
	if (time < fixes[0].time) return null;
	const last = fixes[fixes.length - 1];
	if (time >= last.time) {
		const age = time - last.time;
		if (age > 0 && (!active || age > CARRY_MS)) return null;
		const km = ((last.speedMs ?? 0) * age) / 1e6;
		const heading = (last.heading ?? 0) * RAD;
		const lat = Math.max(-89, Math.min(89, last.lat + ((km * Math.cos(heading)) / EARTH_RADIUS_KM) / RAD));
		const lon = last.lon + ((km * Math.sin(heading)) / (EARTH_RADIUS_KM * Math.max(Math.cos(last.lat * RAD), 0.2))) / RAD;
		return { lat, lon: ((lon + 540) % 360) - 180, windKt: last.windKt, r34Km: last.r34Km, fixTime: last.time, carried: age > 0 };
	}
	let i = 0;
	while (fixes[i + 1].time <= time) i++;
	const a = fixes[i];
	const b = fixes[i + 1];
	if (b.time - a.time > MAX_GAP_MS) return null;
	const f = (time - a.time) / (b.time - a.time);
	return { ...between(a, b, f), windKt: mix(a.windKt, b.windKt, f), r34Km: mix(a.r34Km, b.r34Km, f), fixTime: a.time, carried: false };
}

/** Time the cloud layer shows for a scene time: cyclones are placed at it, so they sit on their clouds. */
export function cloudTime(sceneTime: number, frameTimes: readonly number[]): number {
	if (frameTimes.length === 0) return sceneTime;
	const { a, b, mix: share } = blendPair(framePosition(frameTimes, sceneTime), frameTimes.length);
	return frameTimes[a] + (frameTimes[b] - frameTimes[a]) * share;
}

const KIND: Partial<Record<CycloneBasin, string>> = { L: 'Hurricane', E: 'Hurricane', C: 'Hurricane', W: 'Typhoon' };

/** What the storm is called at this wind, by basin; one-minute sustained winds (NHC, CPHC, JTWC). */
export function cycloneKind(basin: CycloneBasin, windKt: number | null): string {
	if (windKt === null) return 'Tropical cyclone';
	if (windKt < 34) return 'Tropical depression';
	if (windKt < 64) return 'Tropical storm';
	return KIND[basin] ?? 'Cyclone';
}

/** Wind in km/h, to the nearest 5. */
export function windKmh(windKt: number): number {
	return Math.round((windKt * 1.852) / 5) * 5;
}
