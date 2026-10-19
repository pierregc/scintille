import type { StormHighlight, StormHighlights, StormIndexPage, StormSummary } from '../../contract/types';
import { boundedBody } from '../clouds/response';
import { CONTRACT_MAJOR } from '../live/decode';

export const CATALOG_LIMITS = { pages: 3, pageBytes: 128 * 1024, cards: 4, highlights: 12, highlightBytes: 64 * 1024, staleMs: 24 * 3_600_000, timeoutMs: 15_000 };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseCatalogPage(value: unknown, page: number): StormIndexPage {
	if (!record(value) || Number(String(value.schema_version).split('.')[0]) !== CONTRACT_MAJOR || value.page !== page ||
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

const KINDS = ['day', 'week', 'area', 'longest', 'intense', 'largest'];
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
	}
}

export interface StormCard {
	storm: StormSummary;
	reason: string | null;
}

export interface StormSuggestions {
	cards: StormCard[];
	publishedAt: number;
	partial: boolean;
}

/** Recency is the tie-breaker after country and electrical-activity variety within the fetched window. */
export function chooseStorms(storms: readonly StormSummary[], count = CATALOG_LIMITS.cards): StormSummary[] {
	const unique = new Map<string, StormSummary>();
	for (const storm of storms) if (!unique.has(storm.slug)) unique.set(storm.slug, storm);
	const candidates = [...unique.values()]
		.sort((a, b) => Date.parse(b.t_start) - Date.parse(a.t_start) || a.slug.localeCompare(b.slug));
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
	const cards = value.highlights.map((item) => ({ storm: item.storm, reason: reason(item) }));
	return cards.length ? { cards, publishedAt: Date.parse(value.published_at), partial: false } : loadRecent(root, signal, fetchFn);
}

async function loadRecent(root: string, signal: AbortSignal, fetchFn: typeof fetch): Promise<StormSuggestions> {
	const storms: StormSummary[] = [];
	let pages = 1, publishedAt = 0, partial = false;
	for (let page = 0; page < Math.min(pages, CATALOG_LIMITS.pages); page++) {
		try {
			const abort = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_LIMITS.timeoutMs)]);
			const response = await fetchFn(new URL(`storms/index/${page}.json`, root), { signal: abort });
			if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
			const metadata = parseCatalogPage(JSON.parse(new TextDecoder().decode(await boundedBody(response, CATALOG_LIMITS.pageBytes))), page);
			if (page === 0) { pages = metadata.total_pages; publishedAt = Date.parse(metadata.published_at); }
			storms.push(...metadata.storms);
		} catch (error) {
			if (signal.aborted || page === 0) throw error;
			partial = true;
			break;
		}
	}
	signal.throwIfAborted();
	return { cards: chooseStorms(storms).map((storm) => ({ storm, reason: null })), publishedAt, partial };
}
