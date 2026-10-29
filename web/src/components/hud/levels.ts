import type { SoundLevels } from '../../globe/sound';

export const LEVELS_KEY = 'scintille.sound.levels';

/** Levels saved by a previous visit, keeping only valid numbers in [0, 1]. */
export function parseLevels(raw: string | null): Partial<SoundLevels> {
	if (!raw) return {};
	try {
		const data: unknown = JSON.parse(raw);
		if (typeof data !== 'object' || data === null) return {};
		const out: Partial<SoundLevels> = {};
		for (const key of ['music', 'flashes'] as const) {
			const v = (data as Record<string, unknown>)[key];
			if (typeof v === 'number' && v >= 0 && v <= 1) out[key] = v;
		}
		return out;
	} catch {
		return {};
	}
}

export function savedLevels(): Partial<SoundLevels> {
	try {
		return parseLevels(localStorage.getItem(LEVELS_KEY));
	} catch {
		return {};
	}
}

export const levelKey = (input: HTMLInputElement): keyof SoundLevels => (input.dataset.level === 'music' ? 'music' : 'flashes');
