import { describe, expect, it } from 'vitest';
import type { PreferenceStorage } from '../clouds/preference';
import {
	assertDisplayMinutes,
	DEFAULT_DISPLAY_MINUTES,
	DISPLAY_KEY,
	DISPLAY_MINUTES,
	FLASH_ONLY_MS,
	displayMs,
	readDisplayMinutes,
	writeDisplayMinutes,
} from './display';

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
	const data = { ...initial };
	return {
		data,
		getItem: (key) => data[key] ?? null,
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

const throwing: PreferenceStorage = {
	getItem: () => {
		throw new Error('blocked');
	},
	setItem: () => {
		throw new Error('blocked');
	},
};

describe('display duration preference', () => {
	it('defaults to a choice that fits the live window', () => {
		expect(DISPLAY_MINUTES).toContain(DEFAULT_DISPLAY_MINUTES);
		expect(Math.max(...DISPLAY_MINUTES)).toBeLessThanOrEqual(60);
		expect(readDisplayMinutes(null)).toBe(DEFAULT_DISPLAY_MINUTES);
		expect(readDisplayMinutes(memoryStorage())).toBe(DEFAULT_DISPLAY_MINUTES);
	});

	it('round-trips the flash only choice', () => {
		const storage = memoryStorage();
		writeDisplayMinutes(storage, 0);
		expect(readDisplayMinutes(storage)).toBe(0);
	});

	it('round-trips a saved choice', () => {
		const storage = memoryStorage();
		writeDisplayMinutes(storage, 30);
		expect(storage.data[DISPLAY_KEY]).toBe('30');
		expect(readDisplayMinutes(storage)).toBe(30);
	});

	it('ignores unknown values and blocked storage', () => {
		expect(readDisplayMinutes(memoryStorage({ [DISPLAY_KEY]: '7' }))).toBe(DEFAULT_DISPLAY_MINUTES);
		expect(readDisplayMinutes(memoryStorage({ [DISPLAY_KEY]: 'soon' }))).toBe(DEFAULT_DISPLAY_MINUTES);
		expect(readDisplayMinutes(throwing)).toBe(DEFAULT_DISPLAY_MINUTES);
		expect(readDisplayMinutes(memoryStorage({ [DISPLAY_KEY]: '60' }))).toBe(DEFAULT_DISPLAY_MINUTES);
		expect(() => writeDisplayMinutes(throwing, 30)).not.toThrow();
	});

	it('accepts only the offered choices', () => {
		expect(() => assertDisplayMinutes(0)).not.toThrow();
		expect(() => assertDisplayMinutes(15)).toThrow(RangeError);
		expect(displayMs(5)).toBe(300_000);
		expect(displayMs(0)).toBe(FLASH_ONLY_MS);
	});
});
