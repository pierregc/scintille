import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type StormSearchRecord } from '../contract/types';
import { hash } from './search-query';
import { searchCatalog, type SearchBucket } from './search-store';

const now = Date.parse('2026-10-18T12:00:00Z');
const generation = 'a'.repeat(64);
const prefix = `storms/search/${generation}`;
function storm(i: number): StormSearchRecord {
	return { slug: `storm-${String(i).padStart(6, '0')}`, label: 'France', t_start: new Date(now - i * 86400000).toISOString(), t_end: new Date(now).toISOString(), country_code: 'FR', region: 'europe', level: 2, level_name: 'Moderate', flashes: 20, peak_rate: 2, marker: { lat: 40, lon: 2 }, words: ['france'] };
}
async function fixture(records: StormSearchRecord[]) {
	const files = new Map<string, string>();
	files.set('storms/search/latest.json', JSON.stringify({ schema_version: SCHEMA_VERSION, generation, catalog_checked_at: new Date(now).toISOString() }));
	files.set(`${prefix}/manifest.json`, JSON.stringify({ schema_version: SCHEMA_VERSION, generation, published_at: new Date(now).toISOString(), total_storms: records.length, last_observation_time: null }));
	const lists = new Map<string, StormSearchRecord[]>();
	for (const row of records) for (const key of ['all', `region:${row.region}`, `level:${row.level}`, ...row.words.map(w => `word:${w}`)]) lists.set(key, [...(lists.get(key) ?? []), row]);
	for (const [selector, rows] of lists) {
		const path = `${prefix}/lists/${await hash(selector)}`;
		files.set(`${path}/meta.json`, JSON.stringify({ selector, count: rows.length, page_count: Math.ceil(rows.length / 64) }));
		for (let page = 0; page < Math.ceil(rows.length / 64); page++) files.set(`${path}/${page}.json`, JSON.stringify({ page, storms: rows.slice(page * 64, (page + 1) * 64) }));
	}
	const reads: string[] = [];
	const bucket: SearchBucket = { async get(path) {
		reads.push(path);
		const body = files.get(path);
		return body === undefined ? null : { size: new TextEncoder().encode(body).length, body: new Response(body).body as ReadableStream<Uint8Array> };
	} };
	return { bucket, files, reads };
}

describe('bounded R2 catalog search', () => {
	it('traverses older than 150 storms without omissions or duplicates', async () => {
		const { bucket, reads } = await fixture(Array.from({ length: 220 }, (_, i) => storm(i)));
		const slugs: string[] = [];
		let cursor: string | null = null;
		do {
			const params = new URLSearchParams({ q: 'france' });
			if (cursor) params.set('cursor', cursor);
			const metrics = { reads: 0, bytes: 0, candidates: 0 };
			const result = await searchCatalog(bucket, params, now, metrics);
			expect(result.storms.length).toBeLessThanOrEqual(20);
			expect(metrics.reads).toBeLessThanOrEqual(cursor ? 12 : 36);
			expect(metrics.candidates).toBeLessThanOrEqual(256);
			slugs.push(...result.storms.map(r => r.slug)); cursor = result.next_cursor;
		} while (cursor);
		expect(slugs).toEqual(Array.from({ length: 220 }, (_, i) => storm(i).slug));
		expect(reads.every(path => path.startsWith('storms/search/'))).toBe(true);
	});
	it('seeks dates across equal timestamp page boundaries', async () => {
		const rows = Array.from({ length: 190 }, (_, i) => ({ ...storm(i), t_start: new Date(now - Math.floor(i / 70) * 86400000).toISOString() }));
		const { bucket } = await fixture(rows);
		const result = await searchCatalog(bucket, new URLSearchParams({ to: '2026-10-18' }), now);
		expect(result.storms[0].slug).toBe(storm(70).slug);
	});
	it('returns advancing continuation after an empty bounded scan', async () => {
		const rows = Array.from({ length: 700 }, (_, i) => ({ ...storm(i), level: i < 350 ? 1 : 2, words: i < 300 ? ['france'] : ['france', 'paris'] }));
		const { bucket } = await fixture(rows);
		const result = await searchCatalog(bucket, new URLSearchParams({ q: 'paris', level: '1' }), now);
		expect(result.storms).toEqual([]);
		expect(result.exhausted).toBe(false);
		expect(result.next_cursor).toBeTruthy();
	});
	it('rejects malformed, expired and mismatched cursors before scanning', async () => {
		const { bucket } = await fixture(Array.from({ length: 30 }, (_, i) => storm(i)));
		await expect(searchCatalog(bucket, new URLSearchParams('cursor=../../'), now)).rejects.toMatchObject({ status: 400 });
		const result = await searchCatalog(bucket, new URLSearchParams(), now);
		await expect(searchCatalog(bucket, new URLSearchParams({ cursor: result.next_cursor ?? '', q: 'france' }), now)).rejects.toMatchObject({ status: 400 });
		await expect(searchCatalog(bucket, new URLSearchParams({ cursor: result.next_cursor ?? '' }), now + 86400001)).rejects.toMatchObject({ status: 410 });
	});
	it('keeps retained generations when latest changes', async () => {
		const { bucket, files } = await fixture(Array.from({ length: 30 }, (_, i) => storm(i)));
		const result = await searchCatalog(bucket, new URLSearchParams(), now);
		files.set('storms/search/latest.json', JSON.stringify({ schema_version: SCHEMA_VERSION, generation: 'b'.repeat(64), catalog_checked_at: new Date(now + 1000).toISOString() }));
		const continued = await searchCatalog(bucket, new URLSearchParams({ cursor: result.next_cursor ?? '' }), now + 1000);
		expect(continued.generation).toBe(generation);
		expect(continued.storms[0].slug).toBe(storm(20).slug);
	});
	it('distinguishes a missing word from a missing referenced page', async () => {
		const { bucket, files } = await fixture([storm(0)]);
		expect((await searchCatalog(bucket, new URLSearchParams('q=unknown'), now)).exhausted).toBe(true);
		files.delete(`${prefix}/lists/${await hash('all')}/0.json`);
		await expect(searchCatalog(bucket, new URLSearchParams(), now)).rejects.toMatchObject({ status: 503 });
	});
	it('bounds bodies even when object size is false', async () => {
		const bucket: SearchBucket = { async get() { return { size: 1, body: new Response('x'.repeat(5000)).body as ReadableStream<Uint8Array> }; } };
		await expect(searchCatalog(bucket, new URLSearchParams(), now)).rejects.toThrow('too large');
	});
});

it('stops before the response byte ceiling and resumes at the unread record', async () => {
	const rows = Array.from({ length: 32 }, (_, i) => ({ ...storm(i), label: 'é'.repeat(2048), words: ['france', ...Array.from({ length: 20 }, (_, w) => `word${w}${'x'.repeat(100)}`)] }));
	const { bucket, files } = await fixture(rows);
	const path = `${prefix}/lists/${await hash('all')}`;
	files.set(`${path}/meta.json`, JSON.stringify({ selector: 'all', count: rows.length, page_count: 4 }));
	for (let page = 0; page < 4; page++) files.set(`${path}/${page}.json`, JSON.stringify({ page, storms: rows.slice(page * 8, (page + 1) * 8) }));
	const found: string[] = [];
	let cursor: string | null = null;
	do {
		const params = new URLSearchParams(); if (cursor) params.set('cursor', cursor);
		const result = await searchCatalog(bucket, params, now);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65536);
		expect(result.storms.length).toBeGreaterThan(0);
		found.push(...result.storms.map(r => r.slug)); cursor = result.next_cursor;
	} while (cursor);
	expect(found).toEqual(rows.map(r => r.slug));
});

it('checks cursor expiry before a Worker cache hit', async () => {
	const { bucket } = await fixture(Array.from({ length: 30 }, (_, i) => storm(i)));
	const saved = new Map<string, Awaited<ReturnType<typeof searchCatalog>>>();
	const cache = { async get(key: string) { return saved.get(key) ?? null; }, async put(key: string, value: Awaited<ReturnType<typeof searchCatalog>>) { saved.set(key, value); } };
	const first = await searchCatalog(bucket, new URLSearchParams(), now, undefined, cache);
	const params = new URLSearchParams({ cursor: first.next_cursor ?? '' });
	await searchCatalog(bucket, params, now, undefined, cache);
	const metrics = { reads: 0, bytes: 0, candidates: 0 };
	await searchCatalog(bucket, params, now, metrics, cache);
	expect(metrics.reads).toBe(2);
	await expect(searchCatalog(bucket, params, now + 86400001, undefined, cache)).rejects.toMatchObject({ status: 410 });
});
