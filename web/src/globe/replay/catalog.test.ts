import { describe, expect, it } from 'vitest';
import fixture from '../../../../fixtures/storms/index/0.json';
import type { StormSummary } from '../../contract/types';
import { CATALOG_LIMITS, chooseStorms, loadSuggestions, parseCatalogPage } from './catalog';

it('reads the production catalog fixture without confusing storm metrics with replay counts', async () => {
	const requests: string[] = [];
	const fetchFn: typeof fetch = async (input) => { requests.push(String(input)); return Response.json(fixture); };
	const result = await loadSuggestions('https://feed.test/data', new AbortController().signal, fetchFn);
	expect(requests).toEqual(['https://feed.test/data/storms/index/0.json']);
	expect(result.storms[0].flashes).toBe(fixture.storms[0].flashes);
	expect(result.publishedAt).toBe(Date.parse(fixture.published_at));
	expect(result.partial).toBe(false);
});

it('bounds page requests and tolerates duplicate slugs during publication', async () => {
	let requests = 0;
	const fetchFn: typeof fetch = async (input) => {
		const page = Number(new URL(String(input)).pathname.split('/').at(-1)?.replace('.json', ''));
		requests++;
		return Response.json({ ...fixture, page, total_pages: 1_000_000 });
	};
	const result = await loadSuggestions('https://feed.test/', new AbortController().signal, fetchFn);
	expect(requests).toBe(CATALOG_LIMITS.pages);
	expect(result.storms).toHaveLength(1);
});

it('shows no invented storms for empty catalogs and keeps valid first-page results on later errors', async () => {
	const empty = await loadSuggestions('https://feed.test/', new AbortController().signal, async () => Response.json({ ...fixture, total_storms: 0, storms: [] }));
	expect(empty.storms).toEqual([]);
	let requests = 0;
	const partial = await loadSuggestions('https://feed.test/', new AbortController().signal, async () => {
		return ++requests === 1 ? Response.json({ ...fixture, total_pages: 3 }) : new Response('offline', { status: 503 });
	});
	expect(partial.partial).toBe(true);
	expect(partial.storms).toHaveLength(1);
});

describe('bounded, validated discovery', () => {
	it('rejects wrong versions/pages, malformed metrics and non-catalog bodies', () => {
		for (const value of [null, {}, { ...fixture, schema_version: '99.0.0' }, { ...fixture, page: 1 },
			{ ...fixture, storms: [{ ...fixture.storms[0], level: 99 }] },
			{ ...fixture, storms: [{ ...fixture.storms[0], flashes: '3' }] },
		]) expect(() => parseCatalogPage(value, 0)).toThrow('invalid');
	});
	it('rejects oversized responses and first-page failures', async () => {
		await expect(loadSuggestions('https://feed.test/', new AbortController().signal, async () => new Response('x'.repeat(CATALOG_LIMITS.pageBytes + 1)))).rejects.toThrow('too large');
		await expect(loadSuggestions('https://feed.test/', new AbortController().signal, async () => new Response('', { status: 404 }))).rejects.toThrow('HTTP 404');
	});
	it('propagates cancellation and never returns cancelled cards', async () => {
		const request = new AbortController();
		request.abort();
		await expect(loadSuggestions('https://feed.test/', request.signal, async () => Response.json(fixture))).rejects.toThrow();
	});
	it('favours recent storms and then country/level variety, keeping the first duplicate version', () => {
		const make = (slug: string, country: string, level: number, offset: number): StormSummary => ({ ...fixture.storms[0], slug, country_code: country, level, t_start: new Date(Date.parse(fixture.storms[0].t_start) - offset).toISOString() }) as StormSummary;
		const newest = make('newest', 'US', 1, 0);
		const storms = chooseStorms([newest, make('same-region', 'US', 1, 1), make('other-level', 'US', 5, 2), make('other-country', 'BR', 2, 3), { ...newest, flashes: 999 }], 3);
		expect(storms.map((storm) => storm.slug)).toEqual(['newest', 'other-country', 'other-level']);
		expect(storms[0].flashes).toBe(newest.flashes);
	});
});
