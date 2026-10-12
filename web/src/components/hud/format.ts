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

/** Caption under the Clouds switch: the observation time shown, or why there is none. */
export function cloudCaption(visible: boolean, frameTime: number | null, settled: boolean, timeZone?: string): string {
	if (!visible) return '';
	if (frameTime !== null) return `Observed ${formatTime(frameTime, timeZone).slice(0, 5)}`;
	return settled ? 'No cloud data' : '';
}
