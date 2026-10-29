import { SOURCE_VALUES, type Source } from '../../contract/types';
import type { DecodedChunk } from './decode';

/**
 * How far each source plays behind the wall clock in live mode, so that almost every flash is
 * loaded before it is due (ADR 0026).
 */
export const LIVE_DELAY_MS: Record<Source, number> = {
	'glm-east': 70_000,
	'glm-west': 70_000,
	'mtg-li': 720_000,
};

/** Playback delay per binary source index; unknown sources wait as long as the slowest known one. */
export class SourceDelays {
	readonly ms = new Float64Array(256);
	readonly min: number;
	readonly max: number;
	/** Distinct delays, ascending. */
	readonly values: readonly number[];

	constructor(delays: Partial<Record<Source, number>> = {}) {
		const known = SOURCE_VALUES.map((source) => delays[source] ?? 0);
		this.min = Math.min(...known);
		this.max = Math.max(...known);
		this.ms.fill(this.max);
		known.forEach((ms, i) => (this.ms[i] = ms));
		this.values = [...new Set(known)].sort((a, b) => a - b);
	}
}

export const NO_DELAY = new SourceDelays();
export const LIVE_DELAYS = new SourceDelays(LIVE_DELAY_MS);

/** Flashes loaded after their live slot, per source index, from chunks ingested since `since`. */
export class LateFlashes {
	readonly counts = new Uint32Array(256);
	since: number;

	constructor(
		readonly delays: SourceDelays,
		since: number,
	) {
		this.since = since;
	}

	add(chunk: DecodedChunk, ingestStart: number, now: number): void {
		if (!(ingestStart >= this.since)) return;
		const { start, count, columns } = chunk;
		for (let i = 0; i < count; i++) {
			const source = columns.source[i];
			if (start + columns.event_offset_ms[i] + this.delays.ms[source] < now) this.counts[source]++;
		}
	}
}
