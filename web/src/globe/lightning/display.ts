import type { PreferenceStorage } from '../clouds/preference';

/** Choices for how long a flash stays on screen, in minutes of scene time; the live window holds 60. */
export const DISPLAY_MINUTES = [1, 5, 15, 30, 60] as const;
export const DEFAULT_DISPLAY_MINUTES = 5;
export const DISPLAY_KEY = 'scintille.display.minutes';

const MINUTE_MS = 60_000;

export const minutesToMs = (minutes: number): number => minutes * MINUTE_MS;

function isChoice(minutes: number): boolean {
	return (DISPLAY_MINUTES as readonly number[]).includes(minutes);
}

/** Saved display duration in minutes, or the default when missing or unknown. */
export function readDisplayMinutes(storage: PreferenceStorage | null): number {
	try {
		const minutes = Number(storage?.getItem(DISPLAY_KEY));
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
