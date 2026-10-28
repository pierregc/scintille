/** Longest gap between two frames still treated as continuous play, in wall clock ms. */
const MAX_FRAME_MS = 250;

/**
 * Maps scene time to the wall clock time a flash flickers in: replay speed compresses the gaps
 * between flashes, never a flash. A speed change keeps flashes already lit on their own pace.
 */
export class FlashPlayback {
	/** Scene ms per wall clock ms. */
	speed = 1;
	/** Scene time (UTC ms) of the last speed change during play, and the speed before it. */
	pivot = Number.NEGATIVE_INFINITY;
	pivotSpeed = 1;
	#last = Number.NaN;

	update(sceneMs: number, speed: number): void {
		if (!(speed > 0)) throw new RangeError(`speed must be positive, got ${speed}`);
		if (speed !== this.speed) {
			const continuous = Math.abs(sceneMs - this.#last) <= Math.max(speed, this.speed) * MAX_FRAME_MS;
			this.pivot = continuous ? sceneMs : Number.NEGATIVE_INFINITY;
			this.pivotSpeed = this.speed;
			this.speed = speed;
		}
		this.#last = sceneMs;
	}

	/** Wall clock seconds since a flash playing at scene time `at` started, at scene time `now`. */
	age(at: number, now: number): number {
		if (at >= this.pivot || now < this.pivot) return (now - at) / this.speed / 1000;
		return ((now - this.pivot) / this.speed + (this.pivot - at) / this.pivotSpeed) / 1000;
	}

	/** Scene ms before `now` holding every flash started less than `seconds` of wall clock time ago. */
	span(seconds: number, now: number): number {
		const wall = seconds * 1000;
		const back = wall * this.speed;
		if (now < this.pivot || now - back >= this.pivot) return back;
		return now - this.pivot + (wall - (now - this.pivot) / this.speed) * this.pivotSpeed;
	}
}

/** GLSL twin of `FlashPlayback.age`; `time`, `pivot` in seconds from the instance origin. `onScreen` fades out flashes started before `budgetFrom`. */
export const playbackGlsl = /* glsl */ `
uniform float speed;
uniform float pivot;
uniform float pivotSpeed;
uniform float budgetFrom;
uniform float budgetFade;
float wallAge(float time, float at) {
	return at >= pivot || time < pivot ? (time - at) / speed : (time - pivot) / speed + (pivot - at) / pivotSpeed;
}
float onScreen(float at) {
	return smoothstep(budgetFrom - budgetFade, budgetFrom, at);
}
`;
