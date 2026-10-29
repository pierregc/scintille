import { QUALITY_FLAG_VALUES } from '../../contract/types';
import type { SourceDelays } from '../../globe/live/delay';
import type { FlashRing } from '../../globe/live/ring';

const DUPLICATE = 1 << QUALITY_FLAG_VALUES.indexOf('outside-owner-zone');

/** First stored index whose flash is at or after `time`. */
function firstAt(ring: FlashRing, time: number): number {
	let lo = 0;
	let hi = ring.size;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ring.time[ring.slot(mid)] < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Flashes per second shown over the `windowMs` before `now`, each counted once across satellites. */
export function flashRate(ring: FlashRing, delays: SourceDelays, now: number, windowMs = 10_000): number {
	let count = 0;
	for (let i = firstAt(ring, now - windowMs - delays.max), end = firstAt(ring, now - delays.min + 1); i < end; i++) {
		const s = ring.slot(i);
		const due = ring.time[s] + delays.ms[ring.source[s]];
		if (due > now - windowMs && due <= now && !(ring.quality[s] & DUPLICATE)) count++;
	}
	return (count * 1000) / windowMs;
}

/** `47 flashes/s`, one decimal under 10. */
export function rateLabel(perSecond: number): string {
	const value = perSecond >= 10 ? String(Math.round(perSecond)) : perSecond.toFixed(1);
	return `${value} flashes/s`;
}
