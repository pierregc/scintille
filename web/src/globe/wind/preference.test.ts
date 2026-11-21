import { describe, expect, it } from 'vitest';
import { readWindLook, WIND_LOOK_KEY, writeWindLook } from './preference';

function memory(initial?: string) {
	const values = new Map<string, string>(initial === undefined ? [] : [[WIND_LOOK_KEY, initial]]);
	return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

const broken = {
	getItem: (): string | null => { throw new Error('blocked'); },
	setItem: () => { throw new Error('quota'); },
};

describe('wind look preference', () => {
	it('is off unless a look was saved', () => {
		expect(readWindLook(null)).toBeNull();
		expect(readWindLook(memory())).toBeNull();
		expect(readWindLook(memory('off'))).toBeNull();
		expect(readWindLook(memory('storm'))).toBeNull();
		expect(readWindLook(memory('jet'))).toBe('jet');
		expect(readWindLook(memory('surface'))).toBe('surface');
	});

	it('saves the look under its key, off included', () => {
		const storage = memory();
		writeWindLook(storage, 'surface');
		expect(storage.values.get('scintille.wind.look')).toBe('surface');
		expect(readWindLook(storage)).toBe('surface');
		writeWindLook(storage, null);
		expect(storage.values.get('scintille.wind.look')).toBe('off');
		expect(readWindLook(storage)).toBeNull();
	});

	it('survives a storage that refuses', () => {
		expect(readWindLook(broken)).toBeNull();
		expect(() => writeWindLook(broken, 'jet')).not.toThrow();
		expect(() => writeWindLook(null, 'jet')).not.toThrow();
	});
});
