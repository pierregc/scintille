import { wallTime } from './format';

export const DAY_MS = 86_400_000;
export const SPEEDS = [1, 60, 600, 3600] as const;
export const DEFAULT_SPEED = 60;
/** Where "Travel in time" starts: the beginning of the live window. */
export const REPLAY_LOOKBACK_MS = 3_600_000;

/** Midnight of a calendar day in the zone. */
function zonedInstant(year: number, month: number, day: number, timeZone?: string): number {
	const wall = Date.UTC(year, month - 1, day);
	const offsetAt = (t: number) => {
		const w = wallTime(t, timeZone);
		return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
	};
	const guess = wall - offsetAt(wall);
	return wall - offsetAt(guess);
}

/** Local midnight starting the day of `ms`. */
export function dayStart(ms: number, timeZone?: string): number {
	const w = wallTime(ms, timeZone);
	return zonedInstant(w.year, w.month, w.day, timeZone);
}

/** Length of the local day starting at `start`: 23, 24 or 25 hours. */
export function dayLength(start: number, timeZone?: string): number {
	return dayStart(start + 1.5 * DAY_MS, timeZone) - start;
}

/** Position of a time within its local day, 0 to 1. */
export function dayFraction(ms: number, timeZone?: string): number {
	const start = dayStart(ms, timeZone);
	return (ms - start) / dayLength(start, timeZone);
}

/** Time at a fraction of the day starting at `start`, kept inside that day. */
export function timeAtFraction(start: number, fraction: number, timeZone?: string): number {
	const length = dayLength(start, timeZone);
	return start + Math.round(Math.min(Math.max(fraction, 0), 1 - 1 / length) * length);
}

/** Keyboard step on the timeline: 5 minutes, or one hour with Shift. */
export function keyStep(key: string, shift: boolean): number {
	const step = shift ? 3_600_000 : 300_000;
	if (key === 'ArrowRight' || key === 'ArrowUp') return step;
	if (key === 'ArrowLeft' || key === 'ArrowDown') return -step;
	return 0;
}

/** Local midnight of a `YYYY-MM-DD` date input value, or null. */
export function parseDateInput(value: string, timeZone?: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	return m ? zonedInstant(Number(m[1]), Number(m[2]), Number(m[3]), timeZone) : null;
}

/** `YYYY-MM-DD` of the local day of `ms`, for a date input. */
export function dateInputValue(ms: number, timeZone?: string): string {
	const w = wallTime(ms, timeZone);
	return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function speedLabel(speed: number): string {
	return `${speed}×`;
}
