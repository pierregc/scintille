import { describe, expect, it } from 'vitest';
import { SceneClock } from '../clock';
import type { LiveFeed } from '../live';
import { LiveClient } from '../live/client';
import { FlashRing } from '../live/ring';
import { encodeChunk, FakeFeed, FakeVisibility, gzip } from '../live/testing';
import { DayFeed, FlashDays, KEEP_BEHIND_MS, parseDay, parseIndex } from './days';
import { SceneData } from './index';

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = '2026-10-15';
const H18 = Date.parse('2026-10-15T18:00:00Z');
const ROOT = 'https://data.test/';
const MANIFEST = `${ROOT}archive/flashes/manifests/${DAY}.json`;

/** An archive served by a fake fetch: chunks of `per` flashes, one every `step` ms from each hour. */
class FakeArchive {
	readonly requests: string[] = [];
	readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
	days = new Map<string, unknown>();
	index: unknown = { schema_version: 1, first_day: '2026-10-09', last_hour: '2026-10-15T20:00:00Z', retention_days: 21 };

	async hour(start: number, chunks: number[][]): Promise<void> {
		const day = new Date(start).toISOString().slice(0, 10);
		const doc = (this.days.get(day) ?? { schema_version: 1, day, generated_at: '2026-10-16T00:00:00Z', hours: [] }) as { hours: unknown[] };
		const refs = [];
		for (const offsets of chunks) {
			const name = `${(start / 1000).toString(16)}${offsets[0].toString(16)}`.padStart(64, '0');
			const body = await gzip(encodeChunk(start / 1000, offsets.map((offsetMs) => ({ offsetMs, lat: 1, lon: 1 }))));
			this.files.set(`/archive/flashes/chunks/${name}.bin.gz`, body);
			refs.push({
				path: `../chunks/${name}.bin.gz`,
				flash_count: offsets.length,
				size_bytes: body.byteLength,
				event_min: new Date(start + offsets[0]).toISOString(),
				event_max: new Date(start + offsets[offsets.length - 1]).toISOString(),
			});
		}
		doc.hours.push({ start: new Date(start).toISOString(), flash_count: refs.reduce((n, r) => n + r.flash_count, 0), chunks: refs });
		this.days.set(day, doc);
	}

	fetch: typeof fetch = async (input) => {
		const url = String(input);
		this.requests.push(url);
		const { pathname } = new URL(url);
		if (pathname === '/archive/flashes/index.json') return Response.json(this.index);
		const day = /manifests\/(.+)\.json$/.exec(pathname)?.[1];
		if (day) return this.days.has(day) ? Response.json(this.days.get(day)) : new Response('missing', { status: 404 });
		const file = this.files.get(pathname);
		return file ? new Response(file) : new Response('missing', { status: 404 });
	};
}

/** Three chunks per hour at minutes 0-19, 20-39 and 40-59, `n` flashes each. */
const thirds = (n: number) => [0, 20, 40].map((m) => Array.from({ length: n }, (_, i) => m * MIN + i * Math.floor((20 * MIN) / n)));

async function settle(feed: DayFeed, time: number, rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		feed.update(time);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	feed.update(time);
}

function setup(archive: FakeArchive, capacity = 1000, now = H18 + 6 * HOUR) {
	const ring = new FlashRing(capacity);
	const days = new FlashDays({ baseUrl: ROOT, fetch: archive.fetch, now: () => now });
	const feed = new DayFeed({ ring, days, now: () => now });
	return { ring, days, feed };
}

const span = (ring: FlashRing) => [ring.time[ring.slot(0)], ring.time[ring.slot(ring.size - 1)]];

describe('flash archive day index', () => {
	it('accepts the published shape and rejects anything outside the rules', async () => {
		const archive = new FakeArchive();
		await archive.hour(H18, thirds(2));
		const doc = archive.days.get(DAY) as { hours: { chunks: { path: string; size_bytes: number; event_max: string }[] }[] };
		const refs = parseDay(doc, DAY, MANIFEST);
		expect(refs.map((r) => [r.hour, r.last, r.flashCount])).toEqual([[H18, false, 2], [H18, false, 2], [H18, true, 2]]);
		expect(refs[0].url).toMatch(/^https:\/\/data\.test\/archive\/flashes\/chunks\/[0-9a-f]{64}\.bin\.gz$/);
		expect(() => parseDay(doc, '2026-10-16', MANIFEST)).toThrow();
		expect(() => parseDay({ ...doc, schema_version: 2 }, DAY, MANIFEST)).toThrow();
		const bad = (edit: (chunk: { path: string; size_bytes: number; event_max: string }) => void) => {
			const copy = structuredClone(doc);
			edit(copy.hours[0].chunks[0]);
			return () => parseDay(copy, DAY, MANIFEST);
		};
		expect(bad((c) => { c.path = '../../storms/x.bin.gz'; })).toThrow();
		expect(bad((c) => { c.size_bytes = 3 * 1024 * 1024; })).toThrow();
		expect(bad((c) => { c.event_max = '2026-10-15T19:00:00Z'; })).toThrow();
	});

	it('reads the first day and last hour of the index', () => {
		expect(parseIndex({ schema_version: 1, first_day: '2026-10-12', last_hour: '2026-10-29T17:00:00Z' }))
			.toEqual({ firstDay: Date.parse('2026-10-12T00:00:00Z'), lastHour: Date.parse('2026-10-29T17:00:00Z') });
		expect(() => parseIndex({ schema_version: 1 })).toThrow();
	});
});

describe('flash archive feed', () => {
	it('streams the chunks around the playhead in event order', async () => {
		const archive = new FakeArchive();
		await archive.hour(H18, thirds(10));
		await archive.hour(H18 + HOUR, thirds(10));
		const { ring, feed } = setup(archive);
		const t = H18 + 45 * MIN;
		await settle(feed, t);
		expect(span(ring)).toEqual([H18, H18 + HOUR + 18 * MIN]);
		expect(feed.covers(t)).toBe(true);
		expect(feed.covers(H18 + 3 * HOUR)).toBe(false);
	});

	it('shows no data for an hour the archive lacks', async () => {
		const archive = new FakeArchive();
		await archive.hour(H18, thirds(10));
		await archive.hour(H18 + 2 * HOUR, thirds(10));
		const { feed } = setup(archive);
		await settle(feed, H18 + 90 * MIN);
		expect(feed.covers(H18 + 90 * MIN)).toBe(false);
	});

	it('starts over when the playhead goes back', async () => {
		const archive = new FakeArchive();
		await archive.hour(H18, thirds(10));
		await archive.hour(H18 + HOUR, thirds(10));
		await archive.hour(H18 + 2 * HOUR, thirds(10));
		const { ring, feed } = setup(archive);
		await settle(feed, H18 + 2 * HOUR + 50 * MIN);
		const generation = ring.generation;
		await settle(feed, H18 + 10 * MIN);
		expect(ring.generation).not.toBe(generation);
		expect(span(ring)[0]).toBe(H18);
		expect(feed.covers(H18 + 10 * MIN)).toBe(true);
	});

	it('plays forward by appending, keeping what the display window still shows', async () => {
		const archive = new FakeArchive();
		await archive.hour(H18, thirds(100));
		await archive.hour(H18 + HOUR, thirds(100));
		const { ring, feed } = setup(archive, 250);
		await settle(feed, H18 + 5 * MIN);
		const generation = ring.generation;
		expect(ring.size).toBe(200);
		await settle(feed, H18 + 30 * MIN);
		expect(ring.size).toBe(200);
		await settle(feed, H18 + 70 * MIN);
		expect(ring.generation).toBe(generation);
		expect(ring.time[ring.slot(0)]).toBeLessThan(H18 + 70 * MIN - KEEP_BEHIND_MS);
		expect(span(ring)[1]).toBeGreaterThan(H18 + HOUR);
	});

	it('reloads the day index when a chunk was replaced', async () => {
		const archive = new FakeArchive();
		await archive.hour(H18, thirds(10));
		const { feed } = setup(archive);
		archive.files.clear();
		await settle(feed, H18 + 5 * MIN);
		expect(feed.covers(H18 + 5 * MIN)).toBe(false);
		expect(archive.requests.filter((url) => url === MANIFEST).length).toBeGreaterThan(1);
	});
});

describe('free replay', () => {
	it('reads the archive before the live window and the live feed inside it', async () => {
		const archive = new FakeArchive();
		const wall = H18 + 6 * HOUR;
		await archive.hour(H18, thirds(10));
		const feed = new FakeFeed();
		await feed.publish((wall - 10 * MIN) / 1000, 30, 2);
		const visibility = new FakeVisibility();
		const startLive = (ring: FlashRing): LiveFeed => {
			const client = new LiveClient({ baseUrl: ROOT, ring, fetch: (input, init) => feed.fetch(input, init), visibility });
			client.start();
			return { ring, client, stop: () => client.stop() };
		};
		const clock = new SceneClock(() => wall);
		const days = new FlashDays({ baseUrl: ROOT, fetch: archive.fetch, now: () => wall });
		const data = new SceneData(clock, startLive(new FlashRing(1000)), startLive, days);
		try {
			await data.liveClient.idle();
			clock.replay(H18 + 10 * MIN, 1);
			clock.pause();
			for (let i = 0; i < 8; i++) {
				data.update(clock.time());
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			data.update(clock.time());
			expect(data.travelling).toBe(true);
			expect(data.covers(H18 + 10 * MIN)).toBe(true);
			expect(data.ring.time[data.ring.slot(0)]).toBe(H18);
			clock.seek(wall - 20 * MIN);
			data.update(clock.time());
			expect(data.travelling).toBe(false);
			await data.liveClient.idle();
			expect(data.covers(wall - 10 * MIN)).toBe(true);
			clock.live();
			expect(data.travelling).toBe(false);
			await data.liveClient.idle();
			clock.replay(data.coverageStart() ?? 0, 60);
			data.update(clock.time());
			expect(data.travelling).toBe(false);
		} finally { data.dispose(); }
	});
});
