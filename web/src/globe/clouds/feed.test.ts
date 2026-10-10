import { readFile } from 'node:fs/promises';
import { Texture } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeVisibility } from '../live/testing';
import { CloudFeed, type CloudFeedOptions } from './feed';
import type { CloudFrame } from './frame';
import { type CloudManifest, CloudManifestError, frameSources, parseCloudManifest } from './manifest';

const FIXTURES = new URL('../../../../fixtures/live/', import.meta.url);
const BASE = 'https://data.example/';
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 10);

function manifest(hours: number[], tiers = ['2k', '4k']): CloudManifest {
	return {
		generated_at: new Date(T0 + Math.max(...hours, 0) * HOUR).toISOString(),
		window_seconds: 21600,
		attribution: 'Clouds: test',
		frames: hours.map((h) => ({
			time: new Date(T0 + h * HOUR).toISOString(),
			published_at: new Date(T0 + h * HOUR).toISOString(),
			product: `p${h}.nc`,
			reference: 'gfs',
			textures: Object.fromEntries(
				tiers.map((tier) => [tier, { path: `${tier}/f${h}.webp`, width: 1, height: 1, size_bytes: 1 }]),
			),
		})),
	};
}

describe('parseCloudManifest', () => {
	it('accepts the fixture manifest', async () => {
		const json: unknown = JSON.parse(await readFile(new URL('clouds/manifest.json', FIXTURES), 'utf8'));
		const parsed = parseCloudManifest(json);
		expect(parsed.frames[0].time).toBe('2026-07-15T18:00:00Z');
		const [source] = frameSources(parsed, '4k', new URL('clouds/manifest.json', FIXTURES).href, 3);
		await expect(readFile(new URL(source.url))).resolves.toBeDefined();
	});

	it('rejects what the client cannot use', () => {
		expect(() => parseCloudManifest(null)).toThrow(CloudManifestError);
		expect(() => parseCloudManifest({ attribution: 'x' })).toThrow(CloudManifestError);
		expect(() => parseCloudManifest({ attribution: 'x', frames: [{ time: 'soon', textures: {} }] })).toThrow(
			CloudManifestError,
		);
	});
});

describe('frameSources', () => {
	it('keeps the newest frames of one tier, oldest first, resolved against the manifest', () => {
		const sources = frameSources(manifest([2, 0, 1, 3]), '2k', `${BASE}live/clouds/manifest.json`, 2);
		expect(sources).toEqual([
			{ time: T0 + 2 * HOUR, url: `${BASE}live/clouds/2k/f2.webp` },
			{ time: T0 + 3 * HOUR, url: `${BASE}live/clouds/2k/f3.webp` },
		]);
		expect(frameSources(manifest([0, 1], ['2k']), '4k', BASE, 3)).toEqual([]);
		expect(frameSources(manifest([0, 1]), '2k', BASE, 0)).toEqual([]);
	});
});

describe('CloudFeed', () => {
	let served: CloudManifest | null;
	let requests: string[];
	let loads: string[];
	let frames: CloudFrame[];
	let errors: unknown[];
	let visibility: FakeVisibility;
	let feed: CloudFeed | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		served = manifest([0, 1, 2, 3]);
		requests = [];
		loads = [];
		frames = [];
		errors = [];
		visibility = new FakeVisibility();
	});

	afterEach(() => {
		feed?.stop();
		vi.useRealTimers();
	});

	function start(options: Partial<CloudFeedOptions> = {}): CloudFeed {
		feed = new CloudFeed({
			baseUrl: BASE,
			tier: '2k',
			onFrame: (frame) => frames.push(frame),
			fetch: async (input) => {
				requests.push(String(input));
				return served ? Response.json(served) : new Response('missing', { status: 404 });
			},
			load: async (url, time) => {
				loads.push(url);
				return { texture: new Texture(), time };
			},
			visibility,
			random: () => 0.5,
			onError: (error) => errors.push(error),
			...options,
		});
		feed.start();
		return feed;
	}

	it('reads the manifest next to the live feed and loads the newest frames once', async () => {
		const f = start({ frames: 3 });
		await f.idle();
		expect(requests).toEqual([`${BASE}live/clouds/manifest.json`]);
		expect(frames.map((x) => x.time)).toEqual([1, 2, 3].map((h) => T0 + h * HOUR));
		expect(f.attribution).toBe('Clouds: test');
		expect(f.settled).toBe(true);

		served = manifest([1, 2, 3, 4]);
		await vi.advanceTimersByTimeAsync(60_000);
		await f.idle();
		expect(loads.slice(3)).toEqual([`${BASE}live/clouds/2k/f4.webp`]);
	});

	it('loads the tier it was given', async () => {
		const f = start({ tier: '4k', frames: 1 });
		await f.idle();
		expect(loads).toEqual([`${BASE}live/clouds/4k/f3.webp`]);
	});

	it('reloads a revised frame under its new path', async () => {
		const f = start({ frames: 1 });
		await f.idle();
		const revised = manifest([3]);
		revised.frames[0].textures['2k'] = { path: '2k/f3-rev.webp', width: 1, height: 1, size_bytes: 1 };
		served = revised;
		await vi.advanceTimersByTimeAsync(60_000);
		await f.idle();
		expect(frames.map((x) => x.time)).toEqual([T0 + 3 * HOUR, T0 + 3 * HOUR]);
	});

	it('settles without frames and backs off when the manifest is missing', async () => {
		served = null;
		const f = start({ backoff: { initialMs: 120_000, maxMs: 300_000 } });
		await f.idle();
		expect(f.settled).toBe(true);
		expect(f.failures).toBe(1);
		expect(frames).toEqual([]);
		expect(errors).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(requests).toHaveLength(1);
		served = manifest([0]);
		await vi.advanceTimersByTimeAsync(300_000);
		await f.idle();
		expect(f.failures).toBe(0);
		expect(frames).toHaveLength(1);
	});

	it('does not poll while the page is hidden', async () => {
		visibility.set(true);
		const f = start();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(requests).toEqual([]);
		visibility.set(false);
		await f.idle();
		expect(requests).toHaveLength(1);
	});

	it('disposes a texture that arrives after stop', async () => {
		let release: () => void = () => {};
		const texture = new Texture();
		const dispose = vi.spyOn(texture, 'dispose');
		const f = start({
			frames: 1,
			load: (_url, time) => new Promise((resolve) => (release = () => resolve({ texture, time }))),
		});
		await vi.advanceTimersByTimeAsync(0);
		f.stop();
		release();
		await f.idle();
		expect(dispose).toHaveBeenCalled();
		expect(frames).toEqual([]);
	});
});
