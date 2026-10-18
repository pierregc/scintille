import { STORM_SEARCH_REGION_VALUES, type StormSearchQuery } from '../contract/types';

export class SearchError extends Error {
	constructor(message: string, public readonly status = 400) { super(message); }
}

export function normalizeWords(text: string): string[] {
	return [...new Set([...text.normalize('NFKD')].filter(c => !/\p{M}/u.test(c))
		.map(c => c.toLowerCase()).join('').split(/[^\p{L}\p{N}]+/u).filter(Boolean))].sort((a, b) => {
		const left = [...a], right = [...b];
		for (let i = 0; i < Math.min(left.length, right.length); i++) {
			const order = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
			if (order) return order;
		}
		return left.length - right.length;
	});
}

function date(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SearchError('Use UTC dates in YYYY-MM-DD format.');
	const time = Date.parse(`${value}T00:00:00Z`);
	if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new SearchError('This UTC date does not exist.');
	return new Date(time).toISOString();
}

export function parseQuery(params: URLSearchParams): StormSearchQuery {
	for (const [key] of params) if (!['q', 'from', 'to', 'region', 'level', 'cursor'].includes(key) || params.getAll(key).length !== 1) throw new SearchError('Invalid search parameter.');
	const text = params.get('q') ?? '';
	if ([...text].length > 120) throw new SearchError('Search is limited to 120 characters.');
	let start = params.get('from') ? date(params.get('from') ?? '') : null;
	let end = params.get('to') ? date(params.get('to') ?? '') : null;
	let foundDate = false;
	const clean = text.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, value => {
		if (foundDate) throw new SearchError('Use one UTC date or the custom date interval.');
		foundDate = true;
		const month = value.length === 7;
		start = date(month ? `${value}-01` : value);
		const next = new Date(start);
		if (month) next.setUTCMonth(next.getUTCMonth() + 1); else next.setUTCDate(next.getUTCDate() + 1);
		end = next.toISOString();
		return '';
	});
	if (/\d[/-]\d|\d{4}-|\b\d{4}\b/.test(clean)) throw new SearchError('Use YYYY-MM-DD or YYYY-MM for UTC dates.');
	const words = normalizeWords(clean);
	if (words.length > 4) throw new SearchError('Use at most four complete place or country words.');
	if (start && end && start >= end) throw new SearchError('End date must follow start date (end excluded).');
	const region = params.get('region') || null;
	if (region && !STORM_SEARCH_REGION_VALUES.includes(region as typeof STORM_SEARCH_REGION_VALUES[number])) throw new SearchError('Choose a listed region.');
	const level = params.get('level') || null;
	if (level && !/^[1-5]$/.test(level)) throw new SearchError('Choose an activity level from 1 to 5.');
	return { words, start, end, region: region as StormSearchQuery['region'], level: level ? Number(level) : null };
}

export async function hash(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
