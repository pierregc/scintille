/** Refreshes that come this much early still draw, so a 60 Hz screen keeps every frame despite timer jitter. */
const TOLERANCE_MS = 3;

/** Frame rate when the window has the focus, and when it does not. */
export const FOCUSED_FPS = 60;
export const BLURRED_FPS = 30;

/** Skips display refreshes so the globe draws at most `fps` frames a second, whatever the screen's rate. */
export class FramePacer {
	fps: number;
	#next = Number.NEGATIVE_INFINITY;

	constructor(fps = FOCUSED_FPS) {
		this.fps = fps;
	}

	/** Call on each display refresh with its time (ms); true when this one should draw. */
	due(now: number): boolean {
		if (now < this.#next - TOLERANCE_MS) return false;
		const interval = 1000 / this.fps;
		// Draws keep to a fixed schedule, so 90 or 144 Hz screens average the target; a late frame restarts it.
		this.#next = now - this.#next > interval ? now + interval : this.#next + interval;
		return true;
	}
}
