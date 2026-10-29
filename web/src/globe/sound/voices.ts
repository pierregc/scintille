/** A new flash replaces a playing voice only if it is this many times louder. */
export const STEAL_RATIO = 2;

export interface Claim {
	slot: number;
	/** The slot held a voice that must be stopped first. */
	replaced: boolean;
}

/** Fixed set of voice slots, so thunder never piles up into a wall of noise. */
export class VoicePool {
	readonly max: number;
	readonly #end: Float64Array;
	readonly #gain: Float64Array;

	constructor(max: number) {
		if (!Number.isInteger(max) || max <= 0) throw new RangeError(`bad voice count ${max}`);
		this.max = max;
		this.#end = new Float64Array(max);
		this.#gain = new Float64Array(max);
	}

	/** Voices still playing or waiting to start at `now`. */
	active(now: number): number {
		let n = 0;
		for (let i = 0; i < this.max; i++) if (this.#end[i] > now) n++;
		return n;
	}

	/** Takes a free slot, or the quietest one if `gain` is much louder; null when the voice should be dropped. */
	claim(now: number, end: number, gain: number): Claim | null {
		let quietest = 0;
		for (let i = 0; i < this.max; i++) {
			if (this.#end[i] <= now) return this.#take(i, end, gain, false);
			if (this.#gain[i] < this.#gain[quietest]) quietest = i;
		}
		if (gain < this.#gain[quietest] * STEAL_RATIO) return null;
		return this.#take(quietest, end, gain, true);
	}

	reset(): void {
		this.#end.fill(0);
		this.#gain.fill(0);
	}

	#take(slot: number, end: number, gain: number, replaced: boolean): Claim {
		this.#end[slot] = end;
		this.#gain[slot] = gain;
		return { slot, replaced };
	}
}
