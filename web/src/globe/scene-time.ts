import { SOURCE_VALUES, type Source } from '../contract/types';
import type { SourceDelays } from './live/delay';

/** Closer than this to the scene, an observation needs no age. */
export const SAME_TIME_MS = 15 * 60_000;

/** Track samples come once per hourly window; past this, the position is no longer current. */
export const TRACK_CURRENT_MS = 90 * 60_000;

/**
 * Time of the newest flashes the scene draws: the clock in replay, the clock minus the slowest delay
 * of the storm's sources in live (the newest of all sources when no storm is given).
 */
export function observedTime(clockTime: number, delays: SourceDelays, sources: readonly Source[] = []): number {
	if (sources.length === 0) return clockTime - delays.min;
	const lag = Math.max(...sources.map((source) => {
		const i = SOURCE_VALUES.indexOf(source);
		return i < 0 ? delays.max : delays.ms[i];
	}));
	return clockTime - lag;
}

export type TrackState = 'pending' | 'current' | 'lost';

export interface TrackObservation {
	state: TrackState;
	/** Latest track sample at or before the scene time, or null. */
	time: number | null;
}

/** Latest observed position at `time` among ascending sample `times`; never interpolated. */
export function trackObservation(times: readonly number[], time: number): TrackObservation {
	let latest: number | null = null;
	for (const t of times) {
		if (t > time) break;
		latest = t;
	}
	if (latest === null) return { state: 'pending', time: null };
	return { state: time - latest <= TRACK_CURRENT_MS ? 'current' : 'lost', time: latest };
}
