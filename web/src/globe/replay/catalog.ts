import type { StormHighlight, StormHighlights, StormIndexPage, StormMetric, StormSummary } from '../../contract/types';
import { boundedBody } from '../clouds/response';
import { CONTRACT_MAJOR } from '../live/decode';

export const CATALOG_LIMITS = { pages: 3, pageBytes: 128 * 1024, cards: 4, highlights: 12, highlightBytes: 64 * 1024, staleMs: 24 * 3_600_000, timeoutMs: 15_000 };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `page` null accepts `latest.json`, which must be the last page. */
export function parseCatalogPage(value: unknown, page: number | null): StormIndexPage {
	if (!record(value) || Number(String(value.schema_version).split('.')[0]) !== CONTRACT_MAJOR ||
		(page === null ? value.page !== Number(value.total_pages) - 1 : value.page !== page) ||
		value.page_size !== 50 || !Number.isSafeInteger(value.total_pages) || Number(value.total_pages) < 1 ||
		!Number.isSafeInteger(value.total_storms) || Number(value.total_storms) < 0 ||
		!Number.isFinite(Date.parse(String(value.published_at))) || !Array.isArray(value.storms) || value.storms.length > 50) {
		throw new Error('invalid storm catalog');
	}
	for (const storm of value.storms as unknown[]) checkStorm(storm);
	return value as unknown as StormIndexPage;
}

function checkStorm(storm: unknown): asserts storm is StormSummary {
	if (!record(storm) || typeof storm.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(storm.slug) ||
		typeof storm.label !== 'string' || !storm.label.trim() || typeof storm.level_name !== 'string' ||
		!Number.isSafeInteger(storm.level) || Number(storm.level) < 1 || Number(storm.level) > 5 ||
		!Number.isSafeInteger(storm.flashes) || Number(storm.flashes) < 0 ||
		!Number.isSafeInteger(storm.peak_rate) || Number(storm.peak_rate) < 0 ||
		(storm.country_code !== null && typeof storm.country_code !== 'string') ||
		!Number.isFinite(Date.parse(String(storm.t_start))) || !Number.isFinite(Date.parse(String(storm.t_end))) ||
		Date.parse(String(storm.t_start)) > Date.parse(String(storm.t_end))) throw new Error('invalid storm summary');
}

const KINDS = ['day', 'week', 'area', 'longest', 'intense', 'largest', 'stationary'];
const METRICS = ['flashes', 'countries', 'distance_km', 'hours', 'peak_rate', 'area_km2'];
const AREAS: Record<string, string> = { americas: 'the Americas', europe: 'Europe', africa: 'Africa', asia: 'Asia' };

export function parseHighlights(value: unknown): StormHighlights {
	if (!record(value) || Number(String(value.schema_version).split('.')[0]) !== CONTRACT_MAJOR ||
		!Number.isFinite(Date.parse(String(value.published_at))) || !Array.isArray(value.highlights) || value.highlights.length > CATALOG_LIMITS.highlights) {
		throw new Error('invalid storm highlights');
	}
	for (const item of value.highlights as unknown[]) {
		if (!record(item) || !KINDS.includes(String(item.kind)) || (item.kind === 'area') !== (typeof item.area === 'string' && item.area in AREAS)) {
			throw new Error('invalid storm highlight');
		}
		const metric = item.metric;
		if (metric != null && (!record(metric) || !METRICS.includes(String(metric.name)) || !Number.isFinite(metric.value) ||
			Number(metric.value) < 0 || !Number.isSafeInteger(metric.rank) || Number(metric.rank) < 1)) throw new Error('invalid storm metric');
		checkStorm(item.storm);
	}
	return value as unknown as StormHighlights;
}

/** Short reason shown on a card. */
export function reason(highlight: Pick<StormHighlight, 'kind' | 'area'>): string {
	switch (highlight.kind) {
		case 'day': return 'Storm of the day';
		case 'week': return 'Storm of the week';
		case 'area': return `Strongest in ${AREAS[highlight.area ?? ''] ?? 'its area'} today`;
		case 'longest': return 'Longest this week';
		case 'intense': return 'Most intense this week';
		case 'largest': return 'Largest this week';
		case 'stationary': return 'Stalled over one spot this week';
	}
}

/** Start day without year, e.g. "Jul 15". */
export function stormDay(storm: Pick<StormSummary, 't_start'>, locale?: string): string {
	return new Date(storm.t_start).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

const span = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${String(minutes % 60).padStart(2, '0')}` : ''}`;
const SUPERLATIVES: Record<StormMetric['name'], string> = { flashes: 'most', countries: 'most', distance_km: 'farthest', hours: 'longest', peak_rate: 'most', area_km2: 'largest' };
const ORDINALS = ['the', '2nd', '3rd'];

/** The one figure that makes a storm notable, and how it ranks when the title compared storms. */
export function stormFigure(card: StormCard, locale?: string): string {
	const metric = card.metric ?? { name: 'flashes', value: card.storm.flashes, rank: 0 };
	const n = (value: number) => Math.round(value).toLocaleString(locale);
	const figure = {
		flashes: `${n(metric.value)} flashes`,
		countries: `Crossed ${n(metric.value)} countries`,
		distance_km: `Travelled ${n(metric.value)} km`,
		hours: `Lasted ${span(Math.round(metric.value * 60))}`,
		peak_rate: `${n(metric.value)} flashes a minute at its peak`,
		area_km2: `${n(Math.round(metric.value / 100) * 100)} km² wide`,
	}[metric.name];
	const scope = card.kind === 'day' ? 'today' : card.kind === 'week' ? 'this week' : card.kind === 'area' ? `in ${AREAS[card.area ?? '']} today` : null;
	const place = ORDINALS[metric.rank - 1];
	return scope && place ? `${figure}, ${place} ${SUPERLATIVES[metric.name]} ${scope}` : figure;
}

export interface StormCard {
	storm: StormSummary;
	reason: string | null;
	kind?: StormHighlight['kind'];
	area?: StormHighlight['area'];
	metric?: StormMetric | null;
}

export interface StormSuggestions {
	cards: StormCard[];
	publishedAt: number;
	partial: boolean;
}

/** Biggest storms first, then country and level variety, then recency, within the fetched window. */
export function chooseStorms(storms: readonly StormSummary[], count = CATALOG_LIMITS.cards): StormSummary[] {
	const unique = new Map<string, StormSummary>();
	for (const storm of storms) if (!unique.has(storm.slug)) unique.set(storm.slug, storm);
	const candidates = [...unique.values()]
		.sort((a, b) => b.flashes - a.flashes || Date.parse(b.t_start) - Date.parse(a.t_start) || a.slug.localeCompare(b.slug));
	const chosen: StormSummary[] = [];
	const regions = new Set<string | null>();
	const levels = new Set<number>();
	while (candidates.length && chosen.length < count) {
		let best = 0, score = -1;
		for (let i = 0; i < candidates.length; i++) {
			const storm = candidates[i];
			const value = (regions.has(storm.country_code) ? 0 : 2) + (levels.has(storm.level) ? 0 : 1);
			if (value > score) { score = value; best = i; }
		}
		const storm = candidates.splice(best, 1)[0];
		chosen.push(storm);
		regions.add(storm.country_code);
		levels.add(storm.level);
	}
	return chosen;
}

/** Pipeline highlights, or recent index pages while none are published. */
export async function loadSuggestions(baseUrl: string, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<StormSuggestions> {
	const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	const abort = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_LIMITS.timeoutMs)]);
	const response = await fetchFn(new URL('storms/highlights.json', root), { signal: abort });
	if (response.status === 404) return loadRecent(root, signal, fetchFn);
	if (!response.ok) throw new Error(`highlights HTTP ${response.status}`);
	const value = parseHighlights(JSON.parse(new TextDecoder().decode(await boundedBody(response, CATALOG_LIMITS.highlightBytes))));
	signal.throwIfAborted();
	const cards = value.highlights.map((item) => ({ storm: item.storm, reason: reason(item), kind: item.kind, area: item.area, metric: item.metric }));
	return cards.length ? { cards, publishedAt: Date.parse(value.published_at), partial: false } : loadRecent(root, signal, fetchFn);
}

/** `latest.json` first, then the pages before it: pages count from the oldest storm. */
async function loadRecent(root: string, signal: AbortSignal, fetchFn: typeof fetch): Promise<StormSuggestions> {
	const storms: StormSummary[] = [];
	let partial = false;
	const latest = await fetchPage(root, null, signal, fetchFn);
	storms.push(...latest.storms);
	for (let page = latest.page - 1; page >= Math.max(0, latest.page - CATALOG_LIMITS.pages + 1); page--) {
		try {
			storms.push(...(await fetchPage(root, page, signal, fetchFn)).storms);
		} catch (error) {
			if (signal.aborted) throw error;
			partial = true;
			break;
		}
	}
	signal.throwIfAborted();
	return { cards: chooseStorms(storms).map((storm) => ({ storm, reason: null })), publishedAt: Date.parse(latest.published_at), partial };
}

async function fetchPage(root: string, page: number | null, signal: AbortSignal, fetchFn: typeof fetch): Promise<StormIndexPage> {
	const abort = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_LIMITS.timeoutMs)]);
	const response = await fetchFn(new URL(`storms/index/${page ?? 'latest'}.json`, root), { signal: abort });
	if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
	return parseCatalogPage(JSON.parse(new TextDecoder().decode(await boundedBody(response, CATALOG_LIMITS.pageBytes))), page);
}
