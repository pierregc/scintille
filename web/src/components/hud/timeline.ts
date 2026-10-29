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

export interface ScaleWindow {
	start: number;
	end: number;
	recent: boolean;
}

/** The span the bar shows: the last 24 h up to now, or the older local day of `t`. */
export function scaleWindow(t: number, now: number, timeZone?: string): ScaleWindow {
	if (t >= now - DAY_MS) return { start: now - DAY_MS, end: now, recent: true };
	const start = dayStart(t, timeZone);
	return { start, end: Math.min(start + dayLength(start, timeZone), now), recent: false };
}

/** Position of a time in the window, 0 to 1. */
export function windowFraction(w: ScaleWindow, t: number): number {
	return Math.min(Math.max((t - w.start) / (w.end - w.start), 0), 1);
}

/** Time at a fraction of the window; an older day stops just before the next midnight. */
export function timeAtFraction(w: ScaleWindow, fraction: number): number {
	const t = w.start + Math.round(Math.min(Math.max(fraction, 0), 1) * (w.end - w.start));
	return w.recent ? t : Math.min(t, w.end - 1);
}

const QUARTER_MS = 900_000;

/** Half-hour ticks and labels every six local hours, as fractions of the window. */
export function scaleMarks(w: ScaleWindow, timeZone?: string): { ticks: number[]; labels: { at: number; text: string }[] } {
	const ticks: number[] = [];
	const labels: { at: number; text: string }[] = [];
	for (let t = Math.ceil(w.start / QUARTER_MS) * QUARTER_MS; t <= w.end; t += QUARTER_MS) {
		const { hour, minute } = wallTime(t, timeZone);
		if (minute % 30) continue;
		const at = windowFraction(w, t);
		ticks.push(at);
		if (minute || hour % 6 || (w.recent && at > 0.95)) continue;
		labels.push({ at, text: !w.recent && t === w.end ? '24' : String(hour).padStart(2, '0') });
	}
	if (w.recent) labels.push({ at: 1, text: 'now' });
	return { ticks, labels };
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
