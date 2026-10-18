import { describe, expect, it } from 'vitest';
import cases from '../../../fixtures/storms/search/normalization.json';
import { normalizeWords, parseQuery } from './search-query';

describe('catalog queries', () => {
	it.each(cases)('normalizes $input consistently with Python', ({ input, words }) => expect(normalizeWords(input)).toEqual(words));
	it('uses exact UTC day/month boundaries', () => {
		expect(parseQuery(new URLSearchParams({ q: 'France 2024-02' }))).toMatchObject({ words: ['france'], start: '2024-02-01T00:00:00.000Z', end: '2024-03-01T00:00:00.000Z' });
		expect(parseQuery(new URLSearchParams({ q: '2024-02-29' }))).toMatchObject({ start: '2024-02-29T00:00:00.000Z', end: '2024-03-01T00:00:00.000Z' });
	});
	it.each(['2026-02-29', '2026-13', '10/12/2026', '2026-1', 'one two three four five'])('rejects %s', q => expect(() => parseQuery(new URLSearchParams({ q }))).toThrow());
	it('rejects duplicate and unknown parameters', () => {
		expect(() => parseQuery(new URLSearchParams('q=france&q=us'))).toThrow();
		expect(() => parseQuery(new URLSearchParams('path=secret'))).toThrow();
	});
});
