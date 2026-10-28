import type { PreferenceStorage } from '../clouds/preference';

/** Afterglow choices, in minutes of scene time; 0 shows each flash alone, for its wall clock life. */
export const DISPLAY_MINUTES = [0, 1, 30] as const;
export const DEFAULT_DISPLAY_MINUTES = 0;
export const DISPLAY_KEY = 'scintille.display.minutes';

const MINUTE_MS = 60_000;

export const displayMs = (minutes: number): number => minutes * MINUTE_MS;

function isChoice(minutes: number): boolean {
	return (DISPLAY_MINUTES as readonly number[]).includes(minutes);
}

/** Saved display duration in minutes, or the default when missing or unknown. */
export function readDisplayMinutes(storage: PreferenceStorage | null): number {
	try {
		const saved = storage?.getItem(DISPLAY_KEY);
		const minutes = saved ? Number(saved) : NaN;
		return isChoice(minutes) ? minutes : DEFAULT_DISPLAY_MINUTES;
	} catch {
		return DEFAULT_DISPLAY_MINUTES;
	}
}

export function writeDisplayMinutes(storage: PreferenceStorage | null, minutes: number): void {
	try {
		storage?.setItem(DISPLAY_KEY, String(minutes));
	} catch {
		// Private mode or quota: the choice just does not persist.
	}
}

/** Rejects durations outside the offered choices. */
export function assertDisplayMinutes(minutes: number): void {
	if (!isChoice(minutes)) throw new RangeError(`display duration must be one of ${DISPLAY_MINUTES.join(', ')} minutes`);
}
