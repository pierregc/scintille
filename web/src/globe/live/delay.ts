import { SOURCE_VALUES, type Source } from '../../contract/types';

/**
 * How far each source plays behind the wall clock in live mode: above the p99 latency measured
 * in docs/data-contract.md, so flashes are loaded before they are due.
 */
export const LIVE_DELAY_MS: Record<Source, number> = {
	'glm-east': 120_000,
	'glm-west': 120_000,
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
