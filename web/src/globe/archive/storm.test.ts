import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../../contract/types';
import { REPLAY_LIMITS, REPLAY_RETENTION_DAYS, ReplayExpiredError, replayStart, stormSource } from './storm';

async function fixtureFetch() {
	const requests: string[] = [];
	const chunk = new Uint8Array(await readFile(new URL(`../../../../fixtures/${fixture.replay.chunks[0].path}`, import.meta.url)));
	const fetchFn: typeof fetch = async (input) => {
		const url = String(input);
		requests.push(url);
		if (new URL(url).pathname === '/data/storms/2026-07-15-orlando.json') return Response.json(fixture);
		if (new URL(url).pathname === `/data/${fixture.replay.chunks[0].path}`) return new Response(chunk);
		return new Response('missing', { status: 404 });
	};
	return { fetchFn, requests };
}

describe('published storm extracts', () => {
	it('reads the catalog fixture and resolves chunks against the public data root', async () => {
		const { fetchFn, requests } = await fixtureFetch();
		const signal = new AbortController().signal;
		const { detail, source } = await stormSource('https://feed.test/data', fixture.storm.slug, signal, fetchFn);
		const chunks = await source.load(signal);
		expect(detail.replay.selection).toBe('track-bounds');
		expect(source.start).toBe(Date.parse(fixture.storm.t_start));
		expect(source.start).toBe(Date.parse(fixture.replay.chunks[0].event_min));
		expect(chunks[0].count).toBe(3);
		expect(requests[1]).toBe(`https://feed.test/data/${fixture.replay.chunks[0].path}`);
	});

	it('reports an expired replay only when an old storm fails to load', async () => {
		const missing: typeof fetch = async (input) => new URL(String(input)).pathname.endsWith('orlando.json')
			? Response.json(fixture) : new Response('missing', { status: 404 });
		const signal = new AbortController().signal;
		const start = Date.parse(fixture.storm.t_start);
		const day = 86_400_000;
		const old = await stormSource('https://feed.test/', fixture.storm.slug, signal, missing, start + (REPLAY_RETENTION_DAYS + 1) * day);
		await expect(old.source.load(signal)).rejects.toBeInstanceOf(ReplayExpiredError);
		const recent = await stormSource('https://feed.test/', fixture.storm.slug, signal, missing, start + day);
		await expect(recent.source.load(signal)).rejects.not.toBeInstanceOf(ReplayExpiredError);
		const { fetchFn } = await fixtureFetch();
		const kept = await stormSource('https://feed.test/data', fixture.storm.slug, signal, fetchFn, start + (REPLAY_RETENTION_DAYS + 1) * day);
		expect((await kept.source.load(signal))[0].count).toBe(3);
	});

	it('rejects unsupported metadata, wrong slugs, invalid bounds and malformed references', async () => {
		const variants = [
			{ ...fixture, schema_version: '99.0.0' },
			{ ...fixture, storm: { ...fixture.storm, slug: 'other' } },
			{ ...fixture, storm: { ...fixture.storm, t_start: 'invalid' } },
			{ ...fixture, replay: { ...fixture.replay, chunks: [{ path: null }] } },
			{ ...fixture, bounds: { ...fixture.bounds, south: -91 } },
			{ ...fixture, replay: { ...fixture.replay, chunks: [{ ...fixture.replay.chunks[0], path: 'https://other.test/chunk.bin.gz' }] } },
		];
		for (const metadata of variants) {
			const fetchFn: typeof fetch = async () => Response.json(metadata);
			await expect(stormSource('https://feed.test/', fixture.storm.slug, new AbortController().signal, fetchFn)).rejects.toThrow('invalid storm');
		}
	});

	it('rejects oversized exports before downloading chunks', async () => {
		for (const replay of [
			{ ...fixture.replay, flash_count: REPLAY_LIMITS.flashes + 1 },
			{ ...fixture.replay, chunks: [{ ...fixture.replay.chunks[0], size_bytes: REPLAY_LIMITS.storedBytes + 1 }] },
		]) {
			let requests = 0;
			const fetchFn: typeof fetch = async () => { requests++; return Response.json({ ...fixture, replay }); };
			await expect(stormSource('https://feed.test/', fixture.storm.slug, new AbortController().signal, fetchFn)).rejects.toThrow('too large');
			expect(requests).toBe(1);
		}
	});

	it('starts at the first flash the chunks hold, which may be after the catalog start', async () => {
		const chunk = fixture.replay.chunks[0];
		const early = { ...fixture, storm: { ...fixture.storm, t_start: '2026-07-15T17:30:01Z' } };
		const empty = { ...chunk, path: `storms/chunks/${'0'.repeat(64)}.bin.gz`, start: '2026-07-15T17:00:00Z', end: '2026-07-15T18:00:00Z', flash_count: 0, event_min: null, event_max: null };
		const cases: [object, string][] = [
			[early, chunk.event_min],
			[{ ...early, replay: { ...early.replay, chunks: [{ ...chunk, event_min: null }] } }, chunk.start],
			[{ ...early, replay: { ...early.replay, chunks: [empty, chunk] } }, chunk.event_min],
			[{ ...early, replay: { ...early.replay, chunks: [], flash_count: 0 } }, early.storm.t_start],
		];
		for (const [metadata, expected] of cases) {
			const fetchFn: typeof fetch = async () => Response.json(metadata);
			const { source } = await stormSource('https://feed.test/', fixture.storm.slug, new AbortController().signal, fetchFn);
			expect(source.start).toBe(Date.parse(expected));
			expect(replayStart(metadata as StormDetail)).toBe(Date.parse(expected));
		}
		expect(replayStart(early as StormDetail)).toBeGreaterThan(Date.parse(early.storm.t_start));
	});

	it('rejects invalid slugs before fetching', async () => {
		const { fetchFn, requests } = await fixtureFetch();
		await expect(stormSource('https://feed.test/', '../live/manifest', new AbortController().signal, fetchFn)).rejects.toThrow('invalid storm slug');
		expect(requests).toHaveLength(0);
	});
});
