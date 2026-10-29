import { describe, expect, it } from 'vitest';
import { placeFiles } from '../../scripts/places.mjs';
import { matchPlaces, normalizePlace, parsePlaces, type Place, placeFile, placeKeys, placeLabel } from './places';

const files = await placeFiles();
const lookup = (query: string) => {
	const file = placeFile(query);
	return file ? matchPlaces(parsePlaces(JSON.parse(files.get(file.slice(1)) ?? '[]')), query) : [];
};

describe('place lookup', () => {
	it('ignores case, accents and punctuation', () => {
		expect(normalizePlace('  Saint-Étienne ')).toBe('saint etienne');
		expect(normalizePlace('Łódź')).toBe('lodz');
		expect(normalizePlace('Tromsø')).toBe('tromso');
		expect(placeKeys('Saint-Étienne')).toEqual(['sa', 'et']);
	});

	it('finds a place by any of its words, most populous first', () => {
		expect(lookup('lyon')[0].slice(0, 3)).toEqual(['Lyon', 'Auvergne-Rhône-Alpes', 'France']);
		expect(lookup('etienne').map(([name]) => name)).toContain('Saint-Étienne');
		expect(lookup('saint et').map(([name]) => name)).toContain('Saint-Étienne');
		expect(lookup('tromso')[0][0]).toBe('Tromsø');
		const sa = lookup('sa');
		expect(sa).toHaveLength(8);
		expect(sa.map((p) => p[5])).toEqual([...sa.map((p) => p[5])].sort((a, b) => b - a));
	});

	it('needs two letters and fits each lookup in one bounded file', () => {
		expect(placeFile('l')).toBeNull();
		expect(placeFile('Lyon')).toBe('/places/v1/ly.json');
		expect(lookup('zzzz')).toEqual([]);
		expect(Math.max(...[...files.values()].map((body) => body.length))).toBeLessThan(128 * 1024);
	});

	it('rejects malformed files and labels places once per part', () => {
		expect(() => parsePlaces([['Lyon', 'x', 'France', 95, 4.8, 1]])).toThrow();
		expect(() => parsePlaces({})).toThrow();
		const singapore: Place = ['Singapore', 'Singapore', 'Singapore', 1.29, 103.85, 5_000_000];
		expect(placeLabel(singapore)).toBe('Singapore');
	});
});
