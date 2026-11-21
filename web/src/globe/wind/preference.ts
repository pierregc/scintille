import type { PreferenceStorage } from '../clouds/preference';
import type { WindLook } from './types';

export const WIND_LOOK_KEY = 'scintille.wind.look';

/** Saved wind look; null (off) unless the viewer picked one. */
export function readWindLook(storage: PreferenceStorage | null): WindLook | null {
	try {
		const value = storage?.getItem(WIND_LOOK_KEY);
		return value === 'jet' || value === 'surface' ? value : null;
	} catch {
		return null;
	}
}

export function writeWindLook(storage: PreferenceStorage | null, look: WindLook | null): void {
	try {
		storage?.setItem(WIND_LOOK_KEY, look ?? 'off');
	} catch {
		// Private mode or quota: the choice just does not persist.
	}
}
