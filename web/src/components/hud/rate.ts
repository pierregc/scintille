import { type LiveManifest, QUALITY_FLAG_VALUES } from '../../contract/types';
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

/**
 * Flashes per second received from the satellites, before the copies seen by two of them are left out,
 * averaged over the chunks of the last `windowMs` of the manifest. Null when a chunk has no count.
 */
export function receivedRate(manifest: LiveManifest | null, windowMs = 60_000): number | null {
	const chunks = manifest?.chunks ?? [];
	if (!chunks.length) return null;
	const from = Date.parse(chunks[chunks.length - 1].end) - windowMs;
	let count = 0;
	let ms = 0;
	for (let i = chunks.length - 1; i >= 0 && Date.parse(chunks[i].start) >= from; i--) {
		const received = chunks[i].received_count;
		if (received == null) return null;
		count += received;
		ms += Date.parse(chunks[i].end) - Date.parse(chunks[i].start);
	}
	return ms > 0 ? (count * 1000) / ms : null;
}

const format = (perSecond: number) => (perSecond >= 10 ? String(Math.round(perSecond)) : perSecond.toFixed(1));

/** `47 flashes/s shown · 61 received`, one decimal under 10; the second part only with a received rate. */
export function rateLabel(shown: number, received: number | null = null): string {
	const text = `${format(shown)} flashes/s shown`;
	return received === null ? text : `${text} · ${format(received)} received`;
}
