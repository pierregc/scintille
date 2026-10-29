import type { FocusStatus } from '../../globe/focus';
import { ACTIVE_STALE_MS, LEVEL_NAMES } from '../../globe/focus/active';
import { formatAge, SOURCE_LABELS } from '../../globe/live/freshness';
import { SAME_TIME_MS, type TrackObservation } from '../../globe/scene-time';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

export interface WallTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The visitor's IANA time zone. */
export function localZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Calendar fields of an instant in a time zone (month 1 to 12). */
export function wallTime(ms: number, timeZone = localZone()): WallTime {
	let fmt = formatters.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
		});
		formatters.set(timeZone, fmt);
	}
	const parts: Record<string, number> = {};
	for (const p of fmt.formatToParts(ms)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: parts.hour,
		minute: parts.minute,
		second: parts.second,
	};
}

/** `HH:MM:SS` in the time zone. */
export function formatTime(ms: number, timeZone?: string): string {
	const w = wallTime(ms, timeZone);
	return `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** `09 Oct 2026` in the time zone. */
export function formatDate(ms: number, timeZone?: string): string {
	const w = wallTime(ms, timeZone);
	return `${pad(w.day)} ${MONTHS[w.month - 1]} ${w.year}`;
}

/** City of the zone (`Paris`), or its offset at `ms` (`UTC+2`) when it has none. */
export function zoneLabel(timeZone = localZone(), ms = Date.now()): string {
	const [area, ...rest] = timeZone.split('/');
	if (rest.length > 0 && area !== 'Etc') return rest[rest.length - 1].replaceAll('_', ' ');
	const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
		.formatToParts(ms)
		.find((p) => p.type === 'timeZoneName')?.value;
	return (offset ?? 'GMT').replace('GMT', 'UTC');
}

/** ` · 40 min earlier` or ` · 20 min later` than the scene; empty when close to it. */
export function ageSuffix(time: number, reference: number): string {
	const age = reference - time;
	if (!(Math.abs(age) >= SAME_TIME_MS)) return '';
	return ` · ${formatAge(Math.abs(age))} ${age > 0 ? 'earlier' : 'later'}`;
}

/** Where the storm was last seen at the scene time; empty before its first position. */
export function positionCaption(observation: TrackObservation, reference: number, timeZone?: string): string {
	if (observation.time === null) return '';
	const at = formatTime(observation.time, timeZone).slice(0, 5);
	if (observation.state === 'lost') return `No position since ${at}`;
	return `Position observed ${at}${ageSuffix(observation.time, reference)}`;
}

/** Second line of an open replay once its storm has ended. */
export function endedCaption(storm: { t_end: string; closed: boolean }, reference: number, timeZone?: string): string {
	const end = Date.parse(storm.t_end);
	return storm.closed && reference > end ? `Ended · last flash ${formatTime(end, timeZone).slice(0, 5)}` : '';
}

/** Lines under a storm picked on the live globe. */
export function liveCaption(
	{ live, observation, observed }: Pick<FocusStatus, 'live' | 'observation' | 'observed'>,
	wall: number,
	timeZone?: string,
): string[] {
	if (!live) return [];
	const hhmm = (ms: number) => formatTime(ms, timeZone).slice(0, 5);
	const { cell, end } = live;
	const lines = [`${cell.name ?? 'Storm'} · ${LEVEL_NAMES[cell.level - 1] ?? 'Active'} electrical activity so far`];
	if (end?.reason === 'expired' && end.tEnd !== null) lines.push(`Ended · last flash ${hhmm(end.tEnd)}`);
	else if (end?.reason === 'source-gap' && end.tEnd !== null) {
		lines.push(`No data from ${cell.sources.map((s) => SOURCE_LABELS[s] ?? s).join(', ')} since ${hhmm(end.tEnd)}`);
	} else if (end) lines.push('No longer tracked');
	else lines.push(positionCaption({ state: observation.state, time: observation.point?.time ?? null }, observed, timeZone));
	if (live.merged) lines.push(`${live.merged.name ?? 'The storm followed'} merged into it at ${hhmm(live.merged.at)}`);
	if (live.splits.length === 1) lines.push(`A cell split off at ${hhmm(Date.parse(live.splits[0].t_start))}`);
	else if (live.splits.length > 1) lines.push(`${live.splits.length} cells split off`);
	if (wall - live.publishedAt > ACTIVE_STALE_MS) lines.push(`Updates delayed since ${hhmm(live.publishedAt)}`);
	return lines.filter(Boolean);
}
