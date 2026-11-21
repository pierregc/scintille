import { WIND_RULES } from '../../contract/wind';
import type { WindArchiveManifest, WindFrameRef, WindManifest } from './manifest';
import type { WindLevel } from './types';

export const HOUR = 3_600_000;
export const ATTRIBUTION = 'Wind: NOAA NCEP GFS model forecast';
const LIVE_PREFIX = '../../archive/wind/';
const iso = (time: number) => new Date(time).toISOString();

/** Texture path of one level, as the producer names it, under `prefix`. */
export function windPath(level: WindLevel, time: number, prefix = '../', hash = '1a2b3c4d'): string {
	const day = iso(time).slice(0, 10).replaceAll('-', '/');
	const stamp = `${iso(time).slice(0, 13).replaceAll('-', '')}Z`;
	return `${prefix}${level}/${day}/${stamp}-${hash}.webp`;
}

export function windFrame(time: number, prefix: string, hash?: string): WindFrameRef {
	const level = (name: WindLevel) => ({
		path: windPath(name, time, prefix, hash),
		width: WIND_RULES.width,
		height: WIND_RULES.height,
		size_bytes: 300_000,
		scale_ms: WIND_RULES.levels[name].scale_ms,
	});
	return { time: iso(time), published_at: iso(time - 4 * HOUR), reference: 'gfs 2026112106', levels: { '10m': level('10m'), '250hPa': level('250hPa') } };
}

export function liveWindManifest(times: number[]): WindManifest {
	return {
		generated_at: iso(Math.max(0, ...times)),
		window_seconds: 6 * 3600,
		attribution: ATTRIBUTION,
		frames: times.map((t) => windFrame(t, LIVE_PREFIX)),
	};
}

export function archiveWindManifest(day: string, times: number[], expires = (t: number) => t + 30 * 24 * HOUR): WindArchiveManifest {
	return {
		schema_version: WIND_RULES.schema_version,
		day,
		generated_at: iso(Math.max(0, ...times)),
		attribution: ATTRIBUTION,
		frames: times.map((t) => ({ ...windFrame(t, '../'), expires_at: iso(expires(t)) })),
	};
}
