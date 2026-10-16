import { describe, expect, it } from 'vitest';
import { SceneClock } from '../clock';
import type { LiveFeed } from '../live';
import { LiveClient } from '../live/client';
import { decodeChunk } from '../live/decode';
import { FlashRing } from '../live/ring';
import { encodeChunk, FakeFeed, FakeVisibility } from '../live/testing';
import { FlashInstances } from '../lightning/instances';
import { loadArchiveChunks, SceneData, type ArchiveSource } from './index';

function source(start = 100_000, count = 4): ArchiveSource {
	return {
		start,
		end: start + count * 1000,
		load: async () => [decodeChunk(encodeChunk(start / 1000,
			Array.from({ length: count }, (_, i) => ({ offsetMs: i * 1000, lat: i, lon: i }))).buffer)],
	};
}

async function setup(capacity = 8) {
	const feed = new FakeFeed();
	await feed.publish(200, 30, 2);
	const visibility = new FakeVisibility();
	let starts = 0;
	const startLive = (ring: FlashRing): LiveFeed => {
		starts++;
		const client = new LiveClient({ baseUrl: 'https://feed.test/', ring, fetch: (input, init) => feed.fetch(input, init), visibility });
		client.start();
		return { ring, client, stop: () => client.stop() };
	};
	const clock = new SceneClock(() => 200_000);
	const data = new SceneData(clock, startLive(new FlashRing(capacity)), startLive);
	await data.liveClient.idle();
	return { data, clock, feed, visibility, starts: () => starts };
}

function times(ring: FlashRing): number[] {
	return Array.from({ length: ring.size }, (_, i) => ring.time[ring.slot(i)]);
}

describe('archive scene data', () => {
	it('round trips through replay without old GPU flashes or skipped live chunks', async () => {
		const { data, clock, feed, starts } = await setup();
		const instances = new FlashInstances(data.ring);
		try {
			instances.sync(200_000);
			expect(instances.count).toBe(2);
			for (let i = 0; i < 3; i++) {
				expect(await data.open(source())).toBe(true);
				expect(clock.mode).toBe('replay');
				expect(times(data.ring)).toEqual([100_000, 101_000, 102_000, 103_000]);
				instances.sync(100_000);
				expect(instances.count).toBe(4);
				clock.live();
				expect(data.ring.size).toBe(0);
				instances.sync(200_000);
				expect(instances.count).toBe(0);
				await data.live();
				await data.liveClient.idle();
				expect(times(data.ring)).toEqual([170_000, 170_001]);
			}
			expect(starts()).toBe(4);
			expect(feed.chunkRequests()).toHaveLength(4);
		} finally { data.dispose(); }
	});

	it('replenishes a bounded window when seeking backwards in a larger extract', async () => {
		const { data } = await setup(4);
		try {
			await data.open(source(100_000, 20));
			const dataset = data.ring.generation;
			expect(times(data.ring)).toEqual([100_000, 101_000, 102_000, 103_000]);
			data.update(119_000);
			expect(data.ring.generation).toBe(dataset);
			expect(times(data.ring)).toEqual([116_000, 117_000, 118_000, 119_000]);
			data.update(102_000);
			expect(times(data.ring)).toContain(102_000);
			expect(data.coverageStart()).toBe(100_000);
			expect(data.covers(119_000)).toBe(true);
			expect(data.covers(99_000)).toBe(false);
			const generation = data.ring.generation;
			data.update(101_001);
			expect(data.ring.generation).toBe(generation);
		} finally { data.dispose(); }
	});

	it('clears cached instances even for an empty archive at the same scene time', async () => {
		const { data } = await setup();
		const instances = new FlashInstances(data.ring);
		try {
			instances.sync(200_000);
			await data.open(source(200_000, 0));
			instances.sync(200_000);
			expect(instances.count).toBe(0);
			expect(data.ring.written).toBe(0);
		} finally { data.dispose(); }
	});

	it('ignores a superseded loader even when it ignores cancellation', async () => {
		const { data, clock } = await setup();
		let release = () => {};
		const blocked = source();
		blocked.load = () => new Promise((resolve) => {
			release = () => { void source().load(new AbortController().signal).then(resolve); };
		});
		try {
			const first = data.open(blocked);
			await Promise.resolve();
			expect(await data.open(source(300_000))).toBe(true);
			release();
			expect(await first).toBe(false);
			expect(clock.time()).toBe(300_000);
			expect(times(data.ring)[0]).toBe(300_000);
		} finally { data.dispose(); }
	});

	it('keeps current observations and playback after a failed replacement', async () => {
		const { data, clock } = await setup();
		try {
			await data.open(source());
			await expect(data.open({ ...source(), load: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
			expect(clock.time()).toBe(100_000);
			expect(times(data.ring)).toHaveLength(4);
		} finally { data.dispose(); }
	});

	it('cancels pending loads and prevents a return from restarting after disposal', async () => {
		const { data, starts } = await setup();
		let signal: AbortSignal | undefined;
		const opening = data.open({ ...source(), load: (abort) => {
			signal = abort;
			return new Promise((_, reject) => abort.addEventListener('abort', () => reject(abort.reason)));
		} });
		await Promise.resolve();
		data.dispose();
		expect(signal?.aborted).toBe(true);
		expect(await opening).toBe(false);
		await data.live();
		expect(starts()).toBe(1);
		expect(data.ring.size).toBe(0);
	});

	it('does not accept an in-flight live response after archive switching', async () => {
		const { data, feed } = await setup();
		const fetchFn = feed.fetch;
		let release = () => {};
		let requested = () => {};
		const fetching = new Promise<void>((resolve) => { requested = resolve; });
		try {
			await feed.publish(300, 30, 10);
			feed.fetch = async (input, init) => {
				if (String(input).includes('c300-')) {
					requested();
					await new Promise<void>((resolve) => { release = resolve; });
				}
				return fetchFn(input, init);
			};
			const poll = data.liveClient.poll();
			await fetching;
			const opening = data.open(source());
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			release();
			await poll;
			expect(await opening).toBe(true);
			expect(times(data.ring)).toEqual([100_000, 101_000, 102_000, 103_000]);
		} finally { release(); data.dispose(); }
	});

	it('returns from the existing live-window time travel and cancels pending metadata', async () => {
		const { data, clock, feed, visibility } = await setup();
		try {
			clock.replay(150_000);
			await data.live();
			expect(clock.mode).toBe('live');
			let signal: AbortSignal | undefined;
			const pending = data.openStorm('https://feed.test/', 'some-storm', 1, async (_, init) => {
				signal = init?.signal ?? undefined;
				return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal?.reason)));
			});
			await data.live();
			expect(signal?.aborted).toBe(true);
			expect(await pending).toBeNull();
			data.dispose();
			const requests = feed.requests.length;
			visibility.set(true);
			visibility.set(false);
			expect(feed.requests).toHaveLength(requests);
		} finally { data.dispose(); }
	});

});

describe('archive chunk loading', () => {
	it('uses gzip SCNT encoding, opaque relative paths and downloads repeated refs once', async () => {
		const feed = new FakeFeed();
		const ref = await feed.publish(100, 30, 3);
		const chunks = await loadArchiveChunks('https://feed.test/live/extract.json', [ref, ref], new AbortController().signal, feed.fetch);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].count).toBe(3);
		expect(feed.chunkRequests()).toHaveLength(1);
	});

	it('rejects inconsistent counts and propagates fetch failures', async () => {
		const feed = new FakeFeed();
		const ref = await feed.publish(100, 30, 3);
		const load = () => loadArchiveChunks('https://feed.test/live/extract.json', [{ ...ref, flash_count: 4 }], new AbortController().signal, feed.fetch);
		await expect(load()).rejects.toThrow('count mismatch');
		feed.failing = true;
		await expect(load()).rejects.toThrow('503');
	});

	it('makes no request after cancellation', async () => {
		const feed = new FakeFeed();
		const ref = await feed.publish(100, 30, 3);
		const abort = new AbortController();
		abort.abort();
		await expect(loadArchiveChunks('https://feed.test/live/extract.json', [ref], abort.signal, feed.fetch)).rejects.toThrow();
		expect(feed.requests).toHaveLength(0);
	});
});
