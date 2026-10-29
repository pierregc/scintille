/** Place lookup from static prefix files (ADR 0027), built from the GeoNames places of the storm names. */

/** `[name, region, country, lat, lon, population]`. */
export type Place = [string, string, string, number, number, number];

export const PLACES_PATH = '/places/v1/';
export const PLACE_RESULTS = 8;

const LETTERS: Record<string, string> = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th', ħ: 'h' };

/** Lowercase words without accents, separated by single spaces. */
export function normalizePlace(text: string): string {
	return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
		.replace(/[øłđðßæœıþħ]/g, (c) => LETTERS[c] ?? c)
		.replace(/[^a-z0-9]+/g, ' ').trim();
}

/** File keys of a place: the first two letters of each word. */
export function placeKeys(name: string): string[] {
	return [...new Set(normalizePlace(name).split(' ').filter((word) => word.length >= 2).map((word) => word.slice(0, 2)))];
}

/** File holding the places that can match `query`, or null below two letters. */
export function placeFile(query: string): string | null {
	const word = normalizePlace(query).split(' ')[0] ?? '';
	return word.length >= 2 ? `${PLACES_PATH}${word.slice(0, 2)}.json` : null;
}

/** Places with a word starting with the query, most populous first. */
export function matchPlaces(places: readonly Place[], query: string, max = PLACE_RESULTS): Place[] {
	const q = normalizePlace(query);
	if (q.length < 2) return [];
	return places
		.filter(([name]) => ` ${normalizePlace(name)}`.includes(` ${q}`))
		.sort((a, b) => b[5] - a[5] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
		.slice(0, max);
}

export function parsePlaces(value: unknown): Place[] {
	if (!Array.isArray(value)) throw new Error('invalid places');
	for (const place of value as unknown[]) {
		if (!Array.isArray(place) || place.length !== 6 || typeof place[0] !== 'string' || typeof place[1] !== 'string' ||
			typeof place[2] !== 'string' || !place.slice(3).every((n) => typeof n === 'number' && Number.isFinite(n)) ||
			Math.abs(place[3]) > 90 || Math.abs(place[4]) > 180) throw new Error('invalid place');
	}
	return value as Place[];
}

/** "Lyon, Auvergne-Rhône-Alpes, France". */
export const placeLabel = ([name, region, country]: Place) => [name, region, country].filter((part, i, all) => part && all.indexOf(part) === i).join(', ');
