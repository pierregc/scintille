export const DAY_MS = 86_400_000;
export const SPEEDS = [1, 60, 600, 3600] as const;
export const DEFAULT_SPEED = 60;
/** Where "Travel in time" starts: the beginning of the live window. */
export const REPLAY_LOOKBACK_MS = 3_600_000;

export function utcDayStart(utcMs: number): number {
	return Math.floor(utcMs / DAY_MS) * DAY_MS;
}

/** Position of a time within its UTC day, 0 to 1. */
export function dayFraction(utcMs: number): number {
	return (utcMs - utcDayStart(utcMs)) / DAY_MS;
}

/** Time at a fraction of the day starting at `dayStart`, kept inside that day. */
export function timeAtFraction(dayStart: number, fraction: number): number {
	return dayStart + Math.min(Math.max(fraction, 0), 1 - 1 / DAY_MS) * DAY_MS;
}

/** Keyboard step on the timeline: 5 minutes, or one hour with Shift. */
export function keyStep(key: string, shift: boolean): number {
	const step = shift ? 3_600_000 : 300_000;
	if (key === 'ArrowRight' || key === 'ArrowUp') return step;
	if (key === 'ArrowLeft' || key === 'ArrowDown') return -step;
	return 0;
}

/** Midnight UTC of a `YYYY-MM-DD` date input value, or null. */
export function parseDateInput(value: string): number | null {
	const time = Date.parse(`${value}T00:00:00Z`);
	return Number.isNaN(time) ? null : time;
}

export function speedLabel(speed: number): string {
	return `${speed}×`;
}
