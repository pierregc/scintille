import { SOURCE_VALUES } from '../../contract/types';
import type { SourceDelays } from '../../globe/live/delay';
import type { FlashRing } from '../../globe/live/ring';

/** Whether to show the debug panel: on dev and PR Previews, or with `?debug`; `?debug=0` hides it. */
export function debugEnabled(search: string, devOrPreview: boolean): boolean {
	const param = new URLSearchParams(search).get('debug');
	if (param === null) return devOrPreview;
	return param !== '0' && param !== 'false';
}

const SHORT_LABELS = ['GLM E', 'GLM W', 'MTG LI'];

export function shortSourceLabel(index: number): string {
	return SHORT_LABELS[index] ?? `#${index}`;
}

export interface SourceStats {
	label: string;
	/** Flashes held in the ring. */
	held: number;
	/** Flashes played in the last minute. */
	lastMinute: number;
	/** Flashes loaded but still waiting for their playback delay. */
	pending: number;
	/** Flashes loaded after their live slot (`LateFlashes`). */
	late: number;
}

/** Per source counts over the whole ring at playback time `now`. */
export function sourceStats(
	ring: FlashRing,
	delays: SourceDelays,
	now: number,
	late: ArrayLike<number> = [],
): SourceStats[] {
	const held = new Map<number, number>();
	const lastMinute = new Map<number, number>();
	const pending = new Map<number, number>();
	const add = (map: Map<number, number>, key: number) => map.set(key, (map.get(key) ?? 0) + 1);
	for (let i = 0; i < ring.size; i++) {
		const s = ring.slot(i);
		const src = ring.source[s];
		const due = ring.time[s] + delays.ms[src];
		add(held, src);
		if (due > now) add(pending, src);
		else if (due > now - 60_000) add(lastMinute, src);
	}
	const indices = new Set([...SOURCE_VALUES.keys(), ...held.keys()]);
	return [...indices]
		.sort((a, b) => a - b)
		.map((index) => ({
			label: shortSourceLabel(index),
			held: held.get(index) ?? 0,
			lastMinute: lastMinute.get(index) ?? 0,
			pending: pending.get(index) ?? 0,
			late: late[index] ?? 0,
		}));
}

export interface FlashRow {
	/** Written index, unique per flash while it is held. */
	id: number;
	time: number;
	source: number;
	lat: number;
	lon: number;
	intensity: number;
	areaKm2: number;
	durationMs: number;
	quality: number;
}

/** The `limit` latest flashes already played at `now`, newest first. */
export function playedFlashes(ring: FlashRing, delays: SourceDelays, now: number, limit: number): FlashRow[] {
	let lo = 0;
	let hi = ring.size;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ring.time[ring.slot(mid)] <= now) lo = mid + 1;
		else hi = mid;
	}
	const rows: FlashRow[] = [];
	for (let i = lo - 1; i >= 0 && rows.length < limit; i--) {
		const s = ring.slot(i);
		if (ring.time[s] + delays.ms[ring.source[s]] > now) continue;
		rows.push({
			id: ring.written - ring.size + i,
			time: ring.time[s],
			source: ring.source[s],
			lat: ring.lat[s],
			lon: ring.lon[s],
			intensity: ring.intensity[s],
			areaKm2: ring.areaKm2[s],
			durationMs: ring.durationMs[s],
			quality: ring.quality[s],
		});
	}
	return rows;
}
