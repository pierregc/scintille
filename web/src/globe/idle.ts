export const IDLE_DELAY_MS = 20_000;

/** Auto-rotate state: on at arrival, off during input, back on after `delay` ms without input. */
export class IdleRotation {
	#interacting = false;
	#lastInput = Number.NEGATIVE_INFINITY;
	readonly #delay: number;

	constructor(delay = IDLE_DELAY_MS) {
		this.#delay = delay;
	}

	start(now: number): void {
		this.#interacting = true;
		this.#lastInput = now;
	}

	end(now: number): void {
		this.#interacting = false;
		this.#lastInput = now;
	}

	/** Waits a full delay from `now` before rotating again, without ending an input under way. */
	wait(now: number): void {
		this.#lastInput = Math.max(this.#lastInput, now);
	}

	rotating(now: number): boolean {
		return !this.#interacting && now - this.#lastInput >= this.#delay;
	}
}
