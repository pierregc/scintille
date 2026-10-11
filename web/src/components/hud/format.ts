const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS` in UTC. */
export function formatUtcTime(utcMs: number): string {
	const d = new Date(utcMs);
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** `09 Oct 2026` in UTC. */
export function formatUtcDate(utcMs: number): string {
	const d = new Date(utcMs);
	return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Caption under the Clouds switch: the observation time shown, or why there is none. */
export function cloudCaption(visible: boolean, frameTime: number | null, settled: boolean): string {
	if (!visible) return '';
	if (frameTime !== null) return `Observed ${formatUtcTime(frameTime).slice(0, 5)} UTC`;
	return settled ? 'No cloud data' : '';
}
