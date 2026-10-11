/** Minutes on the throughput axis, as in `flashes_per_minute`. */
export const SLOTS = 60;

export interface Frame {
	width: number;
	height: number;
	/** Top of the y axis; shared by all sources so their charts compare. */
	max: number;
}

/** Rounds `n` up to a round number, so the axis label reads well. */
export function niceMax(n: number): number {
	if (n <= 0) return 1;
	const p = 10 ** Math.floor(Math.log10(n));
	return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => k * p >= n) ?? 10) * p;
}

/** Point of minute `i` of a series of `length` values, right-aligned on the 60-minute axis. */
export function point(i: number, value: number, length: number, { width, height, max }: Frame): [number, number] {
	const slot = SLOTS - length + i;
	const x = (slot / (SLOTS - 1)) * width;
	const y = height - (Math.min(value, max) / max) * height;
	return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

/** SVG paths: complete minutes, then the minute in progress (the last value). */
export function paths(values: number[], frame: Frame): { done: string; current: string } {
	const pts = values.map((v, i) => point(i, v, values.length, frame));
	const line = (p: [number, number][]) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
	return {
		done: pts.length > 2 ? line(pts.slice(0, -1)) : '',
		current: pts.length >= 2 ? line(pts.slice(-2)) : '',
	};
}

/** Index of the value nearest to `x`, or null outside the series. */
export function indexAt(x: number, length: number, width: number): number | null {
	if (length === 0) return null;
	const slot = Math.round((x / width) * (SLOTS - 1));
	const i = slot - (SLOTS - length);
	return i >= 0 && i < length ? i : null;
}
