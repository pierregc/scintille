export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const CLOUDS_VISIBLE_KEY = 'scintille.clouds.visible';

/** `localStorage`, or null when the browser blocks it. */
export function browserStorage(): PreferenceStorage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

/** Saved cloud visibility; clouds are on unless turned off. */
export function readCloudsVisible(storage: PreferenceStorage | null): boolean {
	try {
		return storage?.getItem(CLOUDS_VISIBLE_KEY) !== '0';
	} catch {
		return true;
	}
}

export function writeCloudsVisible(storage: PreferenceStorage | null, visible: boolean): void {
	try {
		storage?.setItem(CLOUDS_VISIBLE_KEY, visible ? '1' : '0');
	} catch {
		// Private mode or quota: the choice just does not persist.
	}
}
