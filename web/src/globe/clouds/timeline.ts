/** Frames kept on the GPU; older ones are disposed. */
export const MAX_CLOUD_FRAMES = 6;

/** Fractional index of `time` among ascending frame `times`: i + f between frames i and i + 1, clamped to the ends. */
export function framePosition(times: readonly number[], time: number): number {
	const n = times.length;
	if (n === 0) return Number.NaN;
	if (!(time > times[0])) return 0;
	if (time >= times[n - 1]) return n - 1;
	let i = 0;
	while (times[i + 1] <= time) i++;
	return i + (time - times[i]) / (times[i + 1] - times[i]);
}

/**
 * Eases the displayed position toward the target with time constant `tau` (seconds of wall time),
 * so a new frame fades in instead of popping. Snaps on big jumps (seeks) or a missing position.
 */
export function easePosition(current: number, target: number, dtSeconds: number, tau = 1.2, snap = 2): number {
	if (!Number.isFinite(current) || Math.abs(target - current) > snap) return target;
	return target + (current - target) * Math.exp(-Math.max(dtSeconds, 0) / tau);
}

/** The two frame indices to blend and the weight of the second, for a fractional position. */
export function blendPair(position: number, count: number): { a: number; b: number; mix: number } {
	const a = Math.min(Math.max(Math.floor(position), 0), count - 1);
	const b = Math.min(a + 1, count - 1);
	return { a, b, mix: b === a ? 0 : position - a };
}
