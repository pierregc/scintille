import { describe, expect, it } from 'vitest';
import fixture from '../../../../fixtures/storms/index/latest.json';
import highlights from '../../../../fixtures/storms/highlights.json';
import type { StormMetric, StormSummary } from '../../contract/types';
import { CATALOG_LIMITS, chooseStorms, loadSuggestions, parseCatalogPage, parseHighlights, reason, stormDay, stormFigure } from './catalog';

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
	expect(requests).toEqual(['https://feed.test/storms/highlights.json', 'https://feed.test/storms/index/latest.json']);
	expect(empty.cards[0].reason).toBeNull();
	await expect(loadSuggestions('https://feed.test/', new AbortController().signal, async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503');
	await expect(loadSuggestions('https://feed.test/', new AbortController().signal, async () => new Response('x'.repeat(CATALOG_LIMITS.highlightBytes + 1)))).rejects.toThrow('too large');
});

it('shows every published highlight, weekly records included', async () => {
	const [item] = highlights.highlights;
	const kinds = [['day', null], ['week', null], ['area', 'americas'], ['area', 'europe'], ['area', 'africa'], ['area', 'asia'], ['longest', null], ['intense', null], ['largest', null], ['stationary', null]];
	const all = kinds.map(([kind, area], i) => ({ kind, area, storm: { ...item.storm, slug: `storm-${i}` } }));
	const result = await loadSuggestions('https://feed.test/', new AbortController().signal, async () => Response.json({ ...highlights, highlights: all }));
	expect(result.cards.map((card) => card.reason)).toEqual(['Storm of the day', 'Storm of the week', 'Strongest in the Americas today', 'Strongest in Europe today',
		'Strongest in Africa today', 'Strongest in Asia today', 'Longest this week', 'Most intense this week', 'Largest this week', 'Stalled over one spot this week']);
});

it('rejects malformed highlights and words every reason briefly', () => {
	const [item] = highlights.highlights;
	for (const value of [null, { ...highlights, schema_version: '99.0.0' }, { ...highlights, highlights: [{ ...item, kind: 'best' }] },
		{ ...highlights, highlights: [{ ...item, kind: 'area', area: null }] }, { ...highlights, highlights: [{ ...item, area: 'europe' }] },
		{ ...highlights, highlights: [{ ...item, storm: { ...item.storm, level: 99 } }] },
		{ ...highlights, highlights: Array(13).fill(item) },
		{ ...highlights, highlights: [{ ...item, metric: { name: 'beauty', value: 1, rank: 1 } }] },
		{ ...highlights, highlights: [{ ...item, metric: { name: 'flashes', value: -1, rank: 1 } }] },
		{ ...highlights, highlights: [{ ...item, metric: { name: 'flashes', value: 1, rank: 0 } }] },
	]) expect(() => parseHighlights(value)).toThrow('invalid');
	expect(reason({ kind: 'area', area: 'americas' })).toBe('Strongest in the Americas today');
	expect(reason({ kind: 'largest', area: null })).toBe('Largest this week');
});

it('reads the production catalog fixture without confusing storm metrics with replay counts', async () => {
	const requests: string[] = [];
	const fetchFn = indexOnly((input) => { requests.push(input); return Response.json(fixture); });
	const result = await loadSuggestions('https://feed.test/data', new AbortController().signal, fetchFn);
	expect(requests).toEqual(['https://feed.test/data/storms/index/latest.json']);
	expect(result.cards[0].storm.flashes).toBe(fixture.storms[0].flashes);
	expect(result.publishedAt).toBe(Date.parse(fixture.published_at));
	expect(result.partial).toBe(false);
});

it('reads latest.json then steps back, bounding page requests and tolerating duplicate slugs', async () => {
	const requests: string[] = [];
	const fetchFn = indexOnly((input) => {
		const name = new URL(input).pathname.split('/').at(-1)?.replace('.json', '') ?? '';
		requests.push(name);
		return Response.json({ ...fixture, page: name === 'latest' ? 999_999 : Number(name), total_pages: 1_000_000 });
	});
	const result = await loadSuggestions('https://feed.test/', new AbortController().signal, fetchFn);
	expect(requests).toEqual(['latest', '999998', '999997']);
	expect(requests).toHaveLength(CATALOG_LIMITS.pages);
	expect(result.cards).toHaveLength(1);
});

it('shows no invented storms for empty catalogs and keeps valid first-page results on later errors', async () => {
	const empty = await loadSuggestions('https://feed.test/', new AbortController().signal, indexOnly(() => Response.json({ ...fixture, total_storms: 0, storms: [] })));
	expect(empty.cards).toEqual([]);
	let requests = 0;
	const partial = await loadSuggestions('https://feed.test/', new AbortController().signal, indexOnly(() => {
		return ++requests === 1 ? Response.json({ ...fixture, page: 2, total_pages: 3 }) : new Response('offline', { status: 503 });
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
		expect(() => parseCatalogPage({ ...fixture, total_pages: 2 }, null)).toThrow('invalid');
		expect(parseCatalogPage(fixture, null).page).toBe(0);
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
	it('breaks ties by country/level variety, then recency, country/level variety, keeping the first duplicate version', () => {
		const make = (slug: string, country: string, level: number, offset: number): StormSummary => ({ ...fixture.storms[0], slug, country_code: country, level, t_start: new Date(Date.parse(fixture.storms[0].t_start) - offset).toISOString() }) as StormSummary;
		const newest = make('newest', 'US', 1, 0);
		const storms = chooseStorms([newest, make('same-region', 'US', 1, 1), make('other-level', 'US', 5, 2), make('other-country', 'BR', 2, 3), { ...newest, flashes: 999 }], 3);
		expect(storms.map((storm) => storm.slug)).toEqual(['newest', 'other-country', 'other-level']);
		expect(storms[0].flashes).toBe(newest.flashes);
	});
	it('favours the biggest storms over recent small ones', () => {
		const recent = fixture.storms[0] as StormSummary;
		const big = { ...recent, slug: 'big', flashes: 50_000, t_start: '2026-07-01T00:00:00Z' };
		expect(chooseStorms([recent, big], 1).map((storm) => storm.slug)).toEqual(['big']);
	});
});

it('words the day and the one figure that makes a storm notable', () => {
	const storm = highlights.highlights[0].storm as StormSummary;
	const card = (kind: 'day' | 'week' | 'area' | 'longest' | null, name: StormMetric['name'], value: number, rank = 1, area: 'europe' | null = null) =>
		stormFigure({ storm, reason: null, kind: kind ?? undefined, area, metric: { name, value, rank } }, 'en-US');
	expect(stormDay({ t_start: '2026-07-15T18:00:00Z' }, 'en-US')).toBe('Jul 15');
	expect(card('week', 'flashes', 205272)).toBe('205,272 flashes, the most this week');
	expect(card('day', 'countries', 4, 2)).toBe('Crossed 4 countries, 2nd most today');
	expect(card('area', 'distance_km', 1045.2, 1, 'europe')).toBe('Travelled 1,045 km, the farthest in Europe today');
	expect(card('day', 'hours', 15.9, 4)).toBe('Lasted 15 h 54');
	expect(card('longest', 'hours', 2)).toBe('Lasted 2 h');
	expect(card(null, 'peak_rate', 697)).toBe('697 flashes a minute at its peak');
	expect(card(null, 'area_km2', 82372.9)).toBe('82,400 km² wide');
	expect(stormFigure({ storm: { ...storm, flashes: 12345 }, reason: null }, 'en-US')).toBe('12,345 flashes');
});
