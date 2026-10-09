import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkFormatError } from './decode';
import { LiveClient, backoffDelay, type LiveClientOptions } from './client';
import { FlashRing } from './ring';
import { FakeFeed, FakeVisibility } from './testing';

const T0 = Date.UTC(2026, 6, 15, 18) / 1000;
const POLL = 30_000;

let feed: FakeFeed;
let visibility: FakeVisibility;
let ring: FlashRing;
let errors: unknown[];

function client(options: Partial<LiveClientOptions> = {}): LiveClient {
	return new LiveClient({
		baseUrl: 'https://data.example/',
		ring,
		fetch: feed.fetch,
		visibility,
		random: () => 0.5,
		onError: (error) => errors.push(error),
		pollIntervalMs: POLL,
		...options,
	});
}

/** Lets pending fetches and decompression settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

function duplicates(urls: string[]): string[] {
	return urls.filter((url, i) => urls.indexOf(url) !== i);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	feed = new FakeFeed();
	visibility = new FakeVisibility();
	ring = new FlashRing(10_000);
	errors = [];
});

afterEach(() => {
	vi.useRealTimers();
});

describe('backoffDelay', () => {
	const backoff = { initialMs: 1000, maxMs: 10_000 };

	it('doubles and caps', () => {
		expect([1, 2, 3, 4, 5, 10].map((n) => backoffDelay(n, backoff, () => 1))).toEqual([
			1000, 2000, 4000, 8000, 10_000, 10_000,
		]);
	});

	it('jitters within [d/2, d]', () => {
		expect(backoffDelay(2, backoff, () => 0)).toBe(1000);
		expect(backoffDelay(2, backoff, () => 0.5)).toBe(1500);
	});
});

describe('LiveClient', () => {
	it('downloads the whole manifest on the first poll, then nothing new', async () => {
		for (let i = 0; i < 9; i++) await feed.publish(T0 + i * 30, 30, 5);
		const live = client();
		live.start();
		await settle();
		expect(feed.chunkRequests()).toHaveLength(9);
		expect(ring.size).toBe(45);

		await tick(POLL);
		expect(feed.manifestRequests()).toBe(2);
		expect(feed.chunkRequests()).toHaveLength(9);
		live.stop();
	});

	it('resolves chunk paths against the manifest URL', async () => {
		await feed.publish(T0, 30, 1);
		const live = client({ baseUrl: 'https://data.example' });
		live.start();
		await settle();
		expect(feed.requests).toEqual([
			'https://data.example/live/manifest.json',
			`https://data.example/live/${feed.chunks[0].path}`,
		]);
		live.stop();
	});

	it('fetches only new chunks, whatever their duration, over a 10-minute session', async () => {
		let t = T0;
		const durations = [30, 12, 47, 30, 5];
		for (let i = 0; i < 40; i++) {
			await feed.publish(t, 30, 3);
			t += 30;
		}
		const live = client();
		live.start();
		await settle();
		for (let i = 0; i < 20; i++) {
			const d = durations[i % durations.length];
			await feed.publish(t, d, 3);
			t += d;
			feed.expire(40);
			await tick(POLL);
		}
		const chunks = feed.chunkRequests();
		expect(duplicates(chunks)).toEqual([]);
		expect(chunks).toHaveLength(60);
		expect(ring.written).toBe(180);
		live.stop();
	});

	it('pauses while hidden and catches up without duplicates on return', async () => {
		let t = T0;
		for (let i = 0; i < 10; i++, t += 30) await feed.publish(t, 30, 2);
		const live = client();
		live.start();
		await settle();

		visibility.set(true);
		const manifestsBefore = feed.manifestRequests();
		for (let i = 0; i < 10; i++, t += 30) {
			await feed.publish(t, 30, 2);
			await tick(POLL);
		}
		expect(feed.manifestRequests()).toBe(manifestsBefore);
		expect(feed.chunkRequests()).toHaveLength(10);

		visibility.set(false);
		await settle();
		expect(feed.manifestRequests()).toBe(manifestsBefore + 1);
		expect(feed.chunkRequests()).toHaveLength(20);
		expect(duplicates(feed.chunkRequests())).toEqual([]);
		expect(ring.written).toBe(40);

		await tick(POLL);
		expect(feed.chunkRequests()).toHaveLength(20);
		live.stop();
	});

	it('does not start polling in a hidden tab', async () => {
		visibility.set(true);
		const live = client();
		live.start();
		await tick(5 * POLL);
		expect(feed.requests).toEqual([]);
		live.stop();
	});

	it('backs off on errors and recovers', async () => {
		await feed.publish(T0, 30, 1);
		feed.failing = true;
		const live = client({ backoff: { initialMs: 1000, maxMs: 4000 } });
		live.start();
		await settle();
		expect(live.failures).toBe(1);

		const pollsAt = (ms: number) => tick(ms).then(() => feed.manifestRequests());
		expect(await pollsAt(749)).toBe(1);
		expect(await pollsAt(1)).toBe(2); // 1000 * 0.75
		expect(await pollsAt(1500)).toBe(3); // 2000 * 0.75
		expect(await pollsAt(3000)).toBe(4); // 4000 * 0.75
		expect(await pollsAt(3000)).toBe(5); // capped
		expect(live.failures).toBe(5);

		feed.failing = false;
		await tick(3000);
		expect(live.failures).toBe(0);
		expect(ring.size).toBe(1);
		expect(await pollsAt(POLL)).toBe(7);
		live.stop();
	});

	it('retries a chunk whose download failed, without refetching the others', async () => {
		await feed.publish(T0, 30, 1);
		const missing = await feed.publish(T0 + 30, 30, 1);
		const file = feed.files.get(missing.path);
		feed.files.delete(missing.path);
		const live = client({ backoff: { initialMs: 1000, maxMs: 1000 } });
		live.start();
		await settle();
		expect(live.failures).toBe(1);
		expect(ring.written).toBe(1);

		if (file) feed.files.set(missing.path, file);
		await tick(1000);
		expect(live.failures).toBe(0);
		expect(ring.written).toBe(2);
		expect(feed.chunkRequests().filter((url) => url.endsWith(feed.chunks[0].path))).toHaveLength(1);
		live.stop();
	});

	it('rejects chunks of another major version once', async () => {
		await feed.publish(T0, 30, 1, 3);
		await feed.publish(T0 + 30, 30, 2);
		const live = client();
		live.start();
		await settle();
		expect(ring.written).toBe(2);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(ChunkFormatError);
		expect(live.failures).toBe(0);

		await tick(POLL);
		expect(feed.chunkRequests()).toHaveLength(2);
		live.stop();
	});

	it('rejects a manifest of another major version', async () => {
		await feed.publish(T0, 30, 1);
		feed.majorVersion = 3;
		const live = client();
		live.start();
		await settle();
		expect(feed.chunkRequests()).toEqual([]);
		expect(live.failures).toBe(1);
		live.stop();
	});

	it('ignores a poll while one is running and stops cleanly', async () => {
		for (let i = 0; i < 3; i++) await feed.publish(T0 + i * 30, 30, 1);
		const live = client();
		live.start();
		await live.poll();
		await settle();
		expect(feed.manifestRequests()).toBe(1);

		live.stop();
		await tick(10 * POLL);
		expect(feed.manifestRequests()).toBe(1);
	});
});
