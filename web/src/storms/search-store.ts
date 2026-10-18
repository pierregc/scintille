import { SCHEMA_VERSION, STORM_SEARCH_REGION_VALUES, type StormSearchManifest, type StormSearchMeta, type StormSearchPage, type StormSearchPointer, type StormSearchQuery, type StormSearchRecord, type StormSearchResponse } from '../contract/types';
import { boundedBody } from '../globe/clouds/response';
import { hash, parseQuery, SearchError } from './search-query';

export interface SearchBucket {
	get(path: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
}
export interface SearchCache {
	get(key: string): Promise<StormSearchResponse | null>;
	put(key: string, value: StormSearchResponse): Promise<void>;
}
export interface SearchMetrics { reads: number; bytes: number; candidates: number }
const root = 'storms/search';
const validGeneration = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const stamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const version = (v: unknown) => typeof v === 'string' && /^2\.\d+\.\d+$/.test(v);
const unavailable = () => new SearchError('The storm catalog is unavailable. Try again.', 503);

export function parseRecord(v: unknown): StormSearchRecord {
	if (!object(v) || typeof v.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug) ||
		typeof v.label !== 'string' || !v.label || v.label.length > 2048 || !stamp(v.t_start) || !stamp(v.t_end) || Date.parse(v.t_start) > Date.parse(v.t_end) ||
		!(v.country_code === null || typeof v.country_code === 'string') || !STORM_SEARCH_REGION_VALUES.includes(v.region as typeof STORM_SEARCH_REGION_VALUES[number]) ||
		!uint(v.level) || v.level < 1 || v.level > 5 || typeof v.level_name !== 'string' || !uint(v.flashes) || !uint(v.peak_rate) ||
		!object(v.marker) || typeof v.marker.lat !== 'number' || !Number.isFinite(v.marker.lat) || Math.abs(v.marker.lat) > 90 ||
		typeof v.marker.lon !== 'number' || !Number.isFinite(v.marker.lon) || Math.abs(v.marker.lon) > 180 ||
		!Array.isArray(v.words) || v.words.length > 128 || v.words.some(w => typeof w !== 'string' || !w || w.length > 256) ||
		new TextEncoder().encode(JSON.stringify(v)).length > 8192) throw unavailable();
	return v as unknown as StormSearchRecord;
}

interface Cursor { generation: string; query: string; list: string; page: number; row: number; expires: number }
function decodeCursor(value: string, now: number): Cursor {
	try {
		if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw 0;
		const v: unknown = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
		if (!object(v) || !validGeneration(v.generation) || !validGeneration(v.query) || !validGeneration(v.list) || !uint(v.page) || v.page >= 16777215 || !uint(v.row) || v.row >= 64 || !uint(v.expires) || v.expires > now + 86400000) throw 0;
		if (v.expires <= now) throw new SearchError('Catalog updated. Restart this search.', 410);
		return v as unknown as Cursor;
	} catch (error) { if (error instanceof SearchError) throw error; throw new SearchError('Invalid search cursor. Restart this search.'); }
}
const encodeCursor = (cursor: Cursor) => btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const matches = (r: StormSearchRecord, q: StormSearchQuery) => q.words.every(w => r.words.includes(w)) && (!q.region || r.region === q.region) && (!q.level || r.level === q.level) && (!q.start || Date.parse(r.t_start) >= Date.parse(q.start)) && (!q.end || Date.parse(r.t_start) < Date.parse(q.end));

export async function searchCatalog(bucket: SearchBucket, params: URLSearchParams, now = Date.now(), metrics: SearchMetrics = { reads: 0, bytes: 0, candidates: 0 }, cache?: SearchCache): Promise<StormSearchResponse> {
	const query = parseQuery(params);
	const queryHash = await hash(JSON.stringify(query));
	const cursor = params.get('cursor') ? decodeCursor(params.get('cursor') ?? '', now) : null;
	if (cursor && cursor.query !== queryHash) throw new SearchError('Filters changed. Restart this search.');
	async function read(path: string, limit: number, optional = false): Promise<unknown> {
		if (++metrics.reads > (cursor ? 12 : 36)) throw unavailable();
		const entry = await bucket.get(path);
		if (!entry) { if (optional) return null; throw unavailable(); }
		if (entry.size > limit) { await entry.body.cancel(); throw unavailable(); }
		const bytes = await boundedBody(new Response(entry.body), limit);
		metrics.bytes += bytes.byteLength;
		if (metrics.bytes > (cursor ? 276 * 1024 : 2 * 1024 * 1024)) throw unavailable();
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
	}
	const pointer = await read(`${root}/latest.json`, 4096);
	if (!object(pointer) || !version(pointer.schema_version) || !validGeneration(pointer.generation) || !stamp(pointer.catalog_checked_at)) throw unavailable();
	const current = pointer as unknown as StormSearchPointer;
	const generation = cursor?.generation ?? current.generation;
	const prefix = `${root}/${generation}`;
	const rawManifest = await read(`${prefix}/manifest.json`, 4096, true);
	if (!rawManifest && cursor) throw new SearchError('Catalog updated. Restart this search.', 410);
	if (!object(rawManifest) || !version(rawManifest.schema_version) || rawManifest.generation !== generation || !stamp(rawManifest.published_at) || !uint(rawManifest.total_storms) || !(rawManifest.last_observation_time === null || stamp(rawManifest.last_observation_time))) throw unavailable();
	const manifest = rawManifest as unknown as StormSearchManifest;
	const response: StormSearchResponse = { schema_version: SCHEMA_VERSION, generation, current_generation: current.generation, published_at: manifest.published_at,
		catalog_checked_at: generation === current.generation ? current.catalog_checked_at : manifest.published_at,
		last_observation_time: manifest.last_observation_time, query, storms: [], next_cursor: null, exhausted: true, page_links_available: false };
	const cacheKey = `${generation}/${current.generation}/${current.catalog_checked_at}/${queryHash}/${params.get('cursor') ?? ''}`;
	const cached = await cache?.get(cacheKey);
	if (cached) return cached;
	const finish = async () => { await cache?.put(cacheKey, response); return response; };
	const selectors = [...query.words.map(w => `word:${w}`), ...(query.region ? [`region:${query.region}`] : []), ...(query.level ? [`level:${query.level}`] : [])];
	if (!selectors.length) selectors.push('all');
	let chosen: { key: string; meta: StormSearchMeta } | undefined;
	for (const selector of selectors) {
		const key = await hash(selector);
		const meta = await read(`${prefix}/lists/${key}/meta.json`, 2048, true);
		if (meta === null) return finish();
		if (!object(meta) || meta.selector !== selector || !uint(meta.count) || !uint(meta.page_count) || meta.page_count > 16777215 || (meta.count === 0) !== (meta.page_count === 0) || meta.count > meta.page_count * 64 || meta.count < meta.page_count) throw unavailable();
		if (!chosen || Number(meta.count) < chosen.meta.count) chosen = { key, meta: meta as unknown as StormSearchMeta };
	}
	if (!chosen || !chosen.meta.count) return finish();
	if (cursor && (cursor.list !== chosen.key || cursor.page >= chosen.meta.page_count)) throw new SearchError('Invalid search position. Restart this search.');
	const list = chosen;
	async function pageAt(page: number): Promise<StormSearchPage> {
		const value = await read(`${prefix}/lists/${list.key}/${page}.json`, 65536);
		if (!object(value) || value.page !== page || !Array.isArray(value.storms) || !value.storms.length || value.storms.length > 64) throw unavailable();
		const storms = value.storms.map(parseRecord);
		for (let i = 1; i < storms.length; i++) {
			const a = storms[i - 1], b = storms[i];
			if (Date.parse(a.t_start) < Date.parse(b.t_start) || (a.t_start === b.t_start && a.slug >= b.slug)) throw unavailable();
		}
		return { page, storms };
	}
	let page = cursor?.page ?? 0, row = cursor?.row ?? 0;
	if (!cursor && query.end) {
		let low = 0, high = list.meta.page_count;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			const probe = await pageAt(middle);
			if (Date.parse(probe.storms[probe.storms.length - 1].t_start) >= Date.parse(query.end)) low = middle + 1; else high = middle;
		}
		page = low;
	}
	const continuation = () => {
		response.exhausted = false;
		response.next_cursor = encodeCursor({ generation, query: queryHash, list: list.key, page, row, expires: cursor?.expires ?? now + 86400000 });
	};
	for (let scanned = 0; page < list.meta.page_count && scanned < 4; scanned++) {
		const batch = await pageAt(page);
		if (row >= batch.storms.length) throw new SearchError('Invalid search position. Restart this search.');
		for (; row < batch.storms.length; row++) {
			const storm = batch.storms[row];
			if (query.start && Date.parse(storm.t_start) < Date.parse(query.start)) return finish();
			metrics.candidates++;
			if (matches(storm, query)) {
				response.storms.push(storm);
				// Reserve enough space for a maximum-length cursor and envelope.
				if (new TextEncoder().encode(JSON.stringify(response)).length > 64000 - 1024) { response.storms.pop(); continuation(); return finish(); }
				if (response.storms.length === 20) {
					row++;
					if (row === batch.storms.length) { page++; row = 0; }
					if (page < list.meta.page_count) continuation();
					return finish();
				}
			}
		}
		page++; row = 0;
	}
	if (page < list.meta.page_count) continuation();
	return finish();
}
