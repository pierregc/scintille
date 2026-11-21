import { WIND_RULES } from '../../contract/wind';
import type { WindLevel } from './types';

/** One level of a wind frame (ADR 0039). */
export interface WindLevelRef {
	path: string;
	width: number;
	height: number;
	size_bytes: number;
	scale_ms: number;
}

export interface WindFrameRef {
	/** Forecast valid time. */
	time: string;
	published_at: string;
	reference: string;
	levels: Partial<Record<WindLevel, WindLevelRef>>;
}

export interface WindManifest {
	generated_at: string;
	window_seconds: number;
	attribution: string;
	/** Oldest first. */
	frames: WindFrameRef[];
}

export interface WindArchiveManifest extends Omit<WindManifest, 'window_seconds' | 'frames'> {
	schema_version: number;
	day: string;
	frames: (WindFrameRef & { expires_at: string })[];
}

/** A texture to load: one level of one frame, with an absolute URL. */
export interface WindSource {
	/** Forecast valid time, UTC ms. */
	time: number;
	level: WindLevel;
	url: string;
	scaleMs: number;
	/** UTC ms after which the archive no longer serves it. */
	expires: number;
}

export class WindManifestError extends Error {}

const LEVELS: Readonly<Record<string, { scale_ms: number }>> = WIND_RULES.levels;
const LIVE_PATH = new RegExp(WIND_RULES.live_texture_path_pattern);
const ARCHIVE_PATH = new RegExp(WIND_RULES.texture_path_pattern);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const dayOf = (time: number): string => new Date(time).toISOString().slice(0, 10);

function checkFrames(json: Record<string, unknown>, path: RegExp): asserts json is Record<string, unknown> & { frames: Record<string, unknown>[] } {
	if (!Array.isArray(json.frames) || typeof json.attribution !== 'string' || json.frames.length > WIND_RULES.max_frames) {
		throw new WindManifestError('wind manifest: missing frames or attribution');
	}
	for (const frame of json.frames as unknown[]) {
		if (!isRecord(frame) || !Number.isFinite(Date.parse(String(frame.time))) || !isRecord(frame.levels)) {
			throw new WindManifestError('wind manifest: invalid frame');
		}
		for (const [level, ref] of Object.entries(frame.levels)) {
			const rule = Object.hasOwn(LEVELS, level) ? LEVELS[level] : undefined;
			if (!rule || !isRecord(ref) || typeof ref.path !== 'string' || path.exec(ref.path)?.[1] !== level) {
				throw new WindManifestError('wind manifest: invalid level path');
			}
			if (ref.width !== WIND_RULES.width || ref.height !== WIND_RULES.height || ref.scale_ms !== rule.scale_ms ||
				!Number.isSafeInteger(ref.size_bytes) || Number(ref.size_bytes) < 1 || Number(ref.size_bytes) > WIND_RULES.max_frame_bytes) {
				throw new WindManifestError('wind manifest: invalid level texture');
			}
		}
	}
}

/** The live manifest, `live/wind/manifest.json`; throws `WindManifestError` on anything off contract. */
export function parseWindManifest(json: unknown): WindManifest {
	if (!isRecord(json)) throw new WindManifestError('wind manifest: not an object');
	checkFrames(json, LIVE_PATH);
	if (typeof json.window_seconds !== 'number' || !(json.window_seconds > 0)) {
		throw new WindManifestError('wind manifest: invalid window');
	}
	return json as unknown as WindManifest;
}

/** A daily archive index, `archive/wind/manifests/<day>.json`. */
export function parseWindArchive(json: unknown, day: string): WindArchiveManifest {
	if (!isRecord(json) || json.schema_version !== WIND_RULES.schema_version || json.day !== day) {
		throw new WindManifestError('wind archive: wrong version or day');
	}
	checkFrames(json, ARCHIVE_PATH);
	for (const frame of json.frames) {
		if (dayOf(Date.parse(String(frame.time))) !== day || !Number.isFinite(Date.parse(String(frame.expires_at)))) {
			throw new WindManifestError('wind archive: invalid frame');
		}
	}
	return json as unknown as WindArchiveManifest;
}

/** Every level of every frame, resolved against the manifest URL. */
export function windSources(frames: readonly (WindFrameRef & { expires_at?: string })[], manifestUrl: string): WindSource[] {
	return frames.flatMap((frame) => {
		const time = Date.parse(frame.time);
		const expires = frame.expires_at === undefined ? Infinity : Date.parse(frame.expires_at);
		return Object.entries(frame.levels).flatMap(([level, ref]) => ref
			? [{ time, level: level as WindLevel, url: new URL(ref.path, manifestUrl).href, scaleMs: ref.scale_ms, expires }]
			: []);
	});
}
