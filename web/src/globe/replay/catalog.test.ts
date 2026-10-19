import { describe, expect, it } from 'vitest';
import fixture from '../../../../fixtures/storms/index/0.json';
import highlights from '../../../../fixtures/storms/highlights.json';
import type { StormSummary } from '../../contract/types';
import { CATALOG_LIMITS, chooseStorms, loadSuggestions, parseCatalogPage, parseHighlights, reason } from './catalog';

const missing = new Response('', { status: 404 });
/** Serves index pages through `index`, with no highlights published yet. */
const indexOnly = (index: (input: string) => Response | Promise<Response>): typeof fetch => async (input) =>
	String(input).endsWith('/highlights.json') ? missing.clone() : index(String(input));

it('prefers pipeline highlights, with a reason per card and a single request', async () => {
	const requests: string[] = [];
	const result = await loadSuggestions('https://feed.test/data', new AbortController().signal, async (input) => { requests.push(String(input)); return Response.json(highlights); });
	expect(requests).toEqual(['https://feed.test/data/storms/highlights.json']);
	expect(result.cards.map((card) => [card.storm.slug, card.reason])).toEqual([['2026-07-15-orlando', 'Storm of the day']]);
	expect(result.publishedAt).toBe(Date.parse(highlights.published_at));
});

it('falls back to recent index pages when highlights are empty, and fails on other highlight errors', async () => {
	const requests: string[] = [];
	const empty = await loadSuggestions('https://feed.test/', new AbortController().signal, async (input) => {
		requests.push(String(input));
		return String(input).endsWith('/highlights.json') ? Response.json({ ...highlights, highlights: [] }) : Response.json(fixture);
	});
	expect(requests).toEqual(['https://feed.test/storms/highlights.json', 'https://feed.test/storms/index/0.json']);
	expect(empty.cards[0].reason).toBeNull();
	await expect(loadSuggestions('https://feed.test/', new AbortController().signal, async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503');
	await expect(loadSuggestions('https://feed.test/', new AbortController().signal, async () => new Response('x'.repeat(CATALOG_LIMITS.highlightBytes + 1)))).rejects.toThrow('too large');
});

it('rejects malformed highlights and words every reason briefly', () => {
	const [item] = highlights.highlights;
	for (const value of [null, { ...highlights, schema_version: '99.0.0' }, { ...highlights, highlights: [{ ...item, kind: 'best' }] },
		{ ...highlights, highlights: [{ ...item, kind: 'area', area: null }] }, { ...highlights, highlights: [{ ...item, area: 'europe' }] },
		{ ...highlights, highlights: [{ ...item, storm: { ...item.storm, level: 99 } }] },
		{ ...highlights, highlights: Array(13).fill(item) },
	]) expect(() => parseHighlights(value)).toThrow('invalid');
	expect(reason({ kind: 'area', area: 'americas' })).toBe('Strongest in the Americas today');
	expect(reason({ kind: 'largest', area: null })).toBe('Largest this week');
});

it('reads the production catalog fixture without confusing storm metrics with replay counts', async () => {
	const requests: string[] = [];
	const fetchFn = indexOnly((input) => { requests.push(input); return Response.json(fixture); });
	const result = await loadSuggestions('https://feed.test/data', new AbortController().signal, fetchFn);
	expect(requests).toEqual(['https://feed.test/data/storms/index/0.json']);
	expect(result.cards[0].storm.flashes).toBe(fixture.storms[0].flashes);
	expect(result.publishedAt).toBe(Date.parse(fixture.published_at));
	expect(result.partial).toBe(false);
});

it('bounds page requests and tolerates duplicate slugs during publication', async () => {
	let requests = 0;
	const fetchFn = indexOnly((input) => {
		const page = Number(new URL(input).pathname.split('/').at(-1)?.replace('.json', ''));
		requests++;
		return Response.json({ ...fixture, page, total_pages: 1_000_000 });
	});
	const result = await loadSuggestions('https://feed.test/', new AbortController().signal, fetchFn);
	expect(requests).toBe(CATALOG_LIMITS.pages);
	expect(result.cards).toHaveLength(1);
});

it('shows no invented storms for empty catalogs and keeps valid first-page results on later errors', async () => {
	const empty = await loadSuggestions('https://feed.test/', new AbortController().signal, indexOnly(() => Response.json({ ...fixture, total_storms: 0, storms: [] })));
	expect(empty.cards).toEqual([]);
	let requests = 0;
	const partial = await loadSuggestions('https://feed.test/', new AbortController().signal, indexOnly(() => {
		return ++requests === 1 ? Response.json({ ...fixture, total_pages: 3 }) : new Response('offline', { status: 503 });
	}));
	expect(partial.partial).toBe(true);
	expect(partial.cards).toHaveLength(1);
});

describe('bounded, validated discovery', () => {
	it('rejects wrong versions/pages, malformed metrics and non-catalog bodies', () => {
		for (const value of [null, {}, { ...fixture, schema_version: '99.0.0' }, { ...fixture, page: 1 },
			{ ...fixture, storms: [{ ...fixture.storms[0], level: 99 }] },
			{ ...fixture, storms: [{ ...fixture.storms[0], flashes: '3' }] },
		]) expect(() => parseCatalogPage(value, 0)).toThrow('invalid');
	});
	it('rejects oversized responses and first-page failures', async () => {
		await expect(loadSuggestions('https://feed.test/', new AbortController().signal, indexOnly(() => new Response('x'.repeat(CATALOG_LIMITS.pageBytes + 1))))).rejects.toThrow('too large');
		await expect(loadSuggestions('https://feed.test/', new AbortController().signal, indexOnly(() => new Response('', { status: 404 })))).rejects.toThrow('HTTP 404');
	});
	it('propagates cancellation and never returns cancelled cards', async () => {
		const request = new AbortController();
		request.abort();
		await expect(loadSuggestions('https://feed.test/', request.signal, async () => Response.json(highlights))).rejects.toThrow();
		await expect(loadSuggestions('https://feed.test/', request.signal, indexOnly(() => Response.json(fixture)))).rejects.toThrow();
	});
	it('favours recent storms and then country/level variety, keeping the first duplicate version', () => {
		const make = (slug: string, country: string, level: number, offset: number): StormSummary => ({ ...fixture.storms[0], slug, country_code: country, level, t_start: new Date(Date.parse(fixture.storms[0].t_start) - offset).toISOString() }) as StormSummary;
		const newest = make('newest', 'US', 1, 0);
		const storms = chooseStorms([newest, make('same-region', 'US', 1, 1), make('other-level', 'US', 5, 2), make('other-country', 'BR', 2, 3), { ...newest, flashes: 999 }], 3);
		expect(storms.map((storm) => storm.slug)).toEqual(['newest', 'other-country', 'other-level']);
		expect(storms[0].flashes).toBe(newest.flashes);
	});
});
