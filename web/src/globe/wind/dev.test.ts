import { describe, expect, it } from 'vitest';
import { WIND_RULES } from '../../contract/wind';
import { windFixturePath, windLookFromSearch } from './dev';

describe('dev wind', () => {
	it('reads the look from the URL', () => {
		expect(windLookFromSearch('?wind=jet')).toBe('jet');
		expect(windLookFromSearch('?quality=low&wind=surface')).toBe('surface');
		expect(windLookFromSearch('?wind=silk')).toBeNull();
		expect(windLookFromSearch('')).toBeNull();
	});

	it('serves fixtures at archive paths the contract accepts', () => {
		const pattern = new RegExp(WIND_RULES.texture_path_pattern);
		for (const level of ['10m', '250hPa'] as const) {
			expect(windFixturePath(level).startsWith('archive/wind/')).toBe(true);
			expect(pattern.test(`../${windFixturePath(level).slice('archive/wind/'.length)}`)).toBe(true);
		}
	});
});
