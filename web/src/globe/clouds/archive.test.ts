import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/archive/clouds/manifests/2026-07-15.json';
import contractCases from '../../../../fixtures/archive/clouds/contract-cases.json';
import { CLOUD_ARCHIVE_RULES } from '../../contract/cloud-archive';
import { ArchiveCloudFeed, parseArchive } from './archive';
import type { CloudFrame } from './frame';
import { createClouds } from './index';
import { CloudPlayback } from './playback';
import { boundedBody } from './response';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 15, 18);
const BASE = 'https://example.test/';

it.each(contractCases)('shares producer/reader contract case: $name', (test) => {
	const payload = structuredClone(fixture);
	for (const change of test.changes) {
		let parent: unknown = payload;
		for (const key of change.path.slice(0, -1)) parent = (parent as Record<string, unknown>)[key];
		const last = change.path.at(-1);
		if (last === undefined) throw new Error('empty contract test path');
		(parent as Record<string, unknown>)[last] = change.value;
	}
	if (test.repeat_frames_over_limit) payload.frames = Array(CLOUD_ARCHIVE_RULES.max_frames + 1).fill(payload.frames[0]);
	if (test.accept) expect(() => parseArchive(payload, '2026-07-15')).not.toThrow();
	else expect(() => parseArchive(payload, '2026-07-15')).toThrow();
});

function manifest(day: string, hours: number[]) {
	return {
		...fixture, day,
		frames: hours.map((h) => ({ ...fixture.frames[0], time: new Date(T0 + h * HOUR).toISOString(),
			textures: { '2k': { ...fixture.frames[0].textures['2k'], path: `../2k/2026/07/15/f${Math.round(h * 60)}.webp` } },
		})),
	};
}

function setup(hours = [0, 1, 2], now = () => T0) {
	const clouds = createClouds(1, { storage: null, maxFrames: 3 });
	clouds.setVisible(true);
	const textures: Texture[] = [];
	const requests: string[] = [];
	const load = vi.fn(async (_url: string, time: number): Promise<CloudFrame> => {
		const texture = new Texture({ width: 2048, height: 1024 });
		textures.push(texture);
		return { texture, time };
	});
	const fetchFn = vi.fn(async (input: string | URL | Request) => {
		requests.push(String(input));
		return String(input).endsWith('2026-07-15.json')
			? Response.json(manifest('2026-07-15', hours)) : new Response(null, { status: 404 });
	});
	const feed = new ArchiveCloudFeed({ baseUrl: BASE, tier: '2k', clouds, fetch: fetchFn, load, now });
	return { clouds, feed, textures, requests, fetchFn, load };
}

describe('archive cloud playback', () => {
	it('calls the global fetch unbound by default', async () => {
		const clouds = createClouds(1, { storage: null, maxFrames: 3 });
		clouds.setVisible(true);
		const strict = vi.fn(function (this: unknown, input: string | URL | Request) {
			if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
			return Promise.resolve(String(input).endsWith('2026-07-15.json')
				? Response.json(manifest('2026-07-15', [0])) : new Response(null, { status: 404 }));
		});
		vi.stubGlobal('fetch', strict);
		const load = vi.fn(async (_url: string, time: number) => ({ texture: new Texture(), time }));
		const feed = new ArchiveCloudFeed({ baseUrl: BASE, tier: '2k', clouds, load, now: () => T0 });
		feed.setTime(T0); await feed.idle();
		expect(load).toHaveBeenCalledOnce();
		feed.stop(); clouds.dispose(); vi.unstubAllGlobals();
	});

	it('reads only the day indices within reach and loads nearby historical textures for scene time', async () => {
		const s = setup();
		s.feed.setTime(T0 + HOUR);
		await s.feed.idle();
		s.clouds.setTime(T0 + HOUR);
		expect(s.requests).toEqual([`${BASE}archive/clouds/manifests/2026-07-15.json`]);
		expect(s.clouds.frameTime).toBe(T0 + HOUR);
		expect(s.feed.settled).toBe(true);
		expect(s.feed.attribution).toContain('NOAA');
		expect(s.textures).toHaveLength(3);
		s.feed.stop(); s.clouds.dispose();
	});

	it('disposes the prior window on backwards seeks and returns no wrong-era image', async () => {
		const s = setup([0]);
		s.feed.setTime(T0); await s.feed.idle(); s.clouds.setTime(T0);
		const dispose = vi.spyOn(s.textures[0], 'dispose');
		s.feed.setTime(T0 - 48 * HOUR); await s.feed.idle(); s.clouds.setTime(T0 - 48 * HOUR);
		expect(dispose).toHaveBeenCalledOnce();
		expect(s.clouds.frameTime).toBeNull();
		expect(s.clouds.mesh.visible).toBe(false);
		s.feed.stop(); s.clouds.dispose();
	});

	it('keeps three textures when seeking forward and backwards across windows', async () => {
		const s = setup([0, 1, 2, 3, 4, 5]);
		s.feed.setTime(T0); await s.feed.idle();
		const disposals = s.textures.map((texture) => vi.spyOn(texture, 'dispose'));
		s.feed.setTime(T0 + 4 * HOUR); await s.feed.idle();
		expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
		expect(s.textures).toHaveLength(6);
		const newDisposals = s.textures.slice(3).map((texture) => vi.spyOn(texture, 'dispose'));
		s.feed.setTime(T0); await s.feed.idle();
		expect(newDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
		s.clouds.setTime(T0); expect(s.clouds.frameTime).toBe(T0);
		s.feed.stop(); s.clouds.dispose();
	});

	it('retries negative discovery once the wall-clock minute changes', async () => {
		let wall = T0;
		const s = setup([0], () => wall);
		s.fetchFn.mockImplementation(async () => new Response(null, { status: 404 }));
		s.feed.setTime(T0); await s.feed.idle();
		s.feed.setTime(T0 + 1); await s.feed.idle();
		expect(s.requests).toHaveLength(0); expect(s.fetchFn).toHaveBeenCalledTimes(1);
		wall += 60_000;
		s.fetchFn.mockImplementation(async () => Response.json(manifest('2026-07-15', [0])));
		s.feed.setTime(T0); await s.feed.idle();
		expect(s.fetchFn).toHaveBeenCalledTimes(2); expect(s.load).toHaveBeenCalledOnce();
		s.feed.stop(); s.clouds.dispose();
	});

	it('preserves a useful slow texture while refreshing discovery after a minute', async () => {
		let wall = T0;
		const s = setup([0], () => wall);
		let finish: (frame: CloudFrame) => void = () => {};
		let signal: AbortSignal | undefined;
		const load = vi.fn((_url: string, _time: number, nextSignal: AbortSignal) => {
			signal = nextSignal;
			return new Promise<CloudFrame>((resolve) => { finish = resolve; });
		});
		const feed = new ArchiveCloudFeed({ baseUrl: BASE, tier: '2k', clouds: s.clouds,
			fetch: s.fetchFn, now: () => wall, load });
		feed.setTime(T0);
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
		wall += 61_000;
		feed.setTime(T0);
		await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledTimes(2));
		expect(signal?.aborted).toBe(false);
		finish({ texture: new Texture({ width: 2048, height: 1024 }), time: T0 });
		await feed.idle(); s.clouds.setTime(T0);
		expect(s.clouds.frameTime).toBe(T0);
		expect(load).toHaveBeenCalledOnce();
		feed.stop(); s.clouds.dispose();
	});

	it('reselects sub-hourly images without refetching the same day indices', async () => {
		const s = setup([0, 0.25, 0.5, 0.75, 1, 2, 3]);
		s.feed.setTime(T0); await s.feed.idle();
		s.feed.setTime(T0 + 0.75 * HOUR); await s.feed.idle();
		s.clouds.setTime(T0 + 0.75 * HOUR);
		expect(s.clouds.frameTime).toBe(T0 + 0.75 * HOUR);
		s.feed.setTime(T0 + 2 * HOUR); await s.feed.idle();
		expect(s.fetchFn).toHaveBeenCalledTimes(1);
		s.feed.stop(); s.clouds.dispose();
	});

	it('treats expired, malformed and oversized manifests as unavailable', async () => {
		for (const bad of [
			{ ...manifest('2026-07-15', [0]), schema_version: 99 },
			{ ...manifest('2026-07-15', [0]), frames: Array(97).fill(fixture.frames[0]) },
			{ ...manifest('2026-07-15', [0]), day: '2026-07-14' },
			{ ...manifest('2026-07-15', [0]), frames: [{ ...fixture.frames[0], expires_at: new Date(T0 - 1).toISOString() }] },
			{ ...manifest('2026-07-15', [0]), frames: [{ ...fixture.frames[0], textures: { '2k': { path: 'https://other.test/x.webp' } } }] },
		]) {
			const s = setup();
			s.fetchFn.mockImplementation(async () => Response.json(bad));
			s.feed.setTime(T0); await s.feed.idle(); s.clouds.setTime(T0);
			expect(s.load).not.toHaveBeenCalled(); expect(s.clouds.frameTime).toBeNull();
			expect(s.feed.settled).toBe(true);
			s.feed.stop(); s.clouds.dispose();
		}
	});

	it('coalesces fast scrubs and disposes late decodes after stopping', async () => {
		const s = setup([0]);
		let finish: (frame: CloudFrame) => void = () => {};
		s.load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
		s.feed.setTime(T0);
		await vi.waitFor(() => expect(s.load).toHaveBeenCalledOnce());
		for (let i = 1; i < 100; i++) s.feed.setTime(T0 + i * HOUR);
		s.feed.stop();
		const texture = new Texture(); const dispose = vi.spyOn(texture, 'dispose');
		finish({ texture, time: T0 }); await s.feed.idle();
		expect(dispose).toHaveBeenCalledOnce(); expect(s.load).toHaveBeenCalledOnce();
		expect(s.clouds.frameTime).toBeNull(); s.clouds.dispose();
	});

	it('handles missing texture objects without substituting live data', async () => {
		const s = setup([0]); s.load.mockRejectedValue(new Error('404'));
		s.feed.setTime(T0); await s.feed.idle(); s.clouds.setTime(T0);
		expect(s.clouds.frameTime).toBeNull(); expect(s.feed.settled).toBe(true);
		s.feed.stop(); s.clouds.dispose();
	});
});

describe('scrubbing', () => {
	function tiers(hours: number[]) {
		const base = fixture.frames[0];
		return {
			...fixture, day: '2026-07-15',
			frames: hours.map((h) => ({ ...base, time: new Date(T0 + h * HOUR).toISOString(),
				textures: {
					'2k': { ...base.textures['2k'], path: `../2k/2026/07/15/f${h}.webp` },
					'4k': { ...base.textures['2k'], width: 4096, height: 2048, path: `../4k/2026/07/15/f${h}.webp` },
				},
			})),
		};
	}

	function scrub(hours: number[], wall: { now: number }) {
		const clouds = createClouds(1, { storage: null, maxFrames: 3 });
		clouds.setVisible(true);
		const loads: string[] = [];
		const pending = new Map<string, (frame: CloudFrame) => void>();
		const load = vi.fn(async (url: string, time: number, signal: AbortSignal): Promise<CloudFrame> => {
			loads.push(url.replace(/^.*clouds\//, ''));
			const width = url.includes('/4k/') ? 4096 : 2048;
			await new Promise<CloudFrame>((resolve, reject) => {
				pending.set(url, resolve);
				signal.addEventListener('abort', () => reject(new Error('aborted')));
			});
			return { texture: new Texture({ width, height: width / 2 }), time };
		});
		const finish = async (match: string) => {
			const url = await vi.waitFor(() => {
				const found = [...pending.keys()].find((u) => u.includes(match));
				if (!found) throw new Error(`no load for ${match}`);
				return found;
			});
			pending.get(url)?.({ texture: new Texture(), time: 0 });
			pending.delete(url);
			await new Promise((resolve) => setTimeout(resolve, 0));
		};
		const fetchFn = vi.fn(async (input: string | URL | Request) => String(input).endsWith('2026-07-15.json')
			? Response.json(tiers(hours)) : new Response(null, { status: 404 }));
		const feed = new ArchiveCloudFeed({ baseUrl: BASE, tier: '4k', clouds, fetch: fetchFn, load, now: () => wall.now });
		return { clouds, feed, loads, finish, fetchFn };
	}

	it('shows the blended pair as previews first, then swaps in full frames once settled', async () => {
		const wall = { now: T0 };
		const s = scrub([0, 1, 2, 3], wall);
		s.feed.setTime(T0 + 0.25 * HOUR);
		await vi.waitFor(() => expect(s.loads).toEqual(['2k/2026/07/15/f0.webp']));
		await s.finish('2k/2026/07/15/f0');
		await s.finish('2k/2026/07/15/f1');
		await s.finish('4k/2026/07/15/f2');
		expect(s.loads).toEqual(['2k/2026/07/15/f0.webp', '2k/2026/07/15/f1.webp', '4k/2026/07/15/f2.webp']);
		expect(s.feed.settled).toBe(false);
		s.feed.setTime(T0 + 0.25 * HOUR);
		expect(s.loads).toHaveLength(3);
		wall.now += 500;
		s.feed.setTime(T0 + 0.25 * HOUR);
		await s.finish('4k/2026/07/15/f0');
		await s.finish('4k/2026/07/15/f1');
		expect(s.loads.slice(3)).toEqual(['4k/2026/07/15/f0.webp', '4k/2026/07/15/f1.webp']);
		expect(s.feed.settled).toBe(true);
		s.feed.stop(); s.clouds.dispose();
	});

	it('upgrades the blended pair before fetching the next frame once the scene is still', async () => {
		const wall = { now: T0 };
		const s = scrub([0, 1, 2, 3], wall);
		s.feed.setTime(T0 + 0.25 * HOUR);
		await s.finish('2k/2026/07/15/f0');
		wall.now += 500;
		await s.finish('2k/2026/07/15/f1');
		await s.finish('4k/2026/07/15/f0');
		await s.finish('4k/2026/07/15/f1');
		await s.finish('4k/2026/07/15/f2');
		expect(s.loads.slice(2)).toEqual(['4k/2026/07/15/f0.webp', '4k/2026/07/15/f1.webp', '4k/2026/07/15/f2.webp']);
		s.feed.stop(); s.clouds.dispose();
	});

	it('lets a missing frame of the blended pair go before a full frame that is not shown yet', async () => {
		const wall = { now: T0 };
		const s = scrub([0, 1, 2, 3, 4], wall);
		s.feed.setTime(T0 + 0.25 * HOUR);
		await s.finish('2k/2026/07/15/f0'); await s.finish('2k/2026/07/15/f1');
		await vi.waitFor(() => expect(s.loads.at(-1)).toBe('4k/2026/07/15/f2.webp'));
		s.feed.setTime(T0 + 3.25 * HOUR);
		await vi.waitFor(() => expect(s.loads.at(-1)).toBe('2k/2026/07/15/f3.webp'));
		s.feed.stop(); s.clouds.dispose();
	});

	it('keeps an in-flight frame that is still close enough and shows it', async () => {
		const wall = { now: T0 };
		const s = scrub([0, 1, 2, 3, 4, 5], wall);
		s.feed.setTime(T0);
		await vi.waitFor(() => expect(s.loads).toHaveLength(1));
		s.feed.setTime(T0 + 2 * HOUR);
		await s.finish('2k/2026/07/15/f0');
		s.clouds.setTime(T0 + 2 * HOUR);
		expect(s.clouds.frameTime).toBe(T0);
		expect(s.loads[1]).toBe('2k/2026/07/15/f2.webp');
		s.feed.setTime(T0 + 5.5 * HOUR);
		await vi.waitFor(() => expect(s.loads[2]).toBe('2k/2026/07/15/f5.webp'));
		expect(s.clouds.frameTimes).toEqual([]);
		s.feed.stop(); s.clouds.dispose();
	});

	it('keeps the old frames on screen until the new ones replace the farthest', async () => {
		const wall = { now: T0 };
		const s = scrub([0, 1, 2, 3, 4, 5], wall);
		s.feed.setTime(T0 + 3 * HOUR);
		await s.finish('f3'); await s.finish('f2'); await s.finish('f4');
		expect(s.clouds.frameTimes).toEqual([2, 3, 4].map((h) => T0 + h * HOUR));
		s.feed.setTime(T0 + 1.25 * HOUR); s.clouds.setTime(T0 + 1.25 * HOUR);
		expect(s.clouds.mesh.visible).toBe(true);
		expect(s.clouds.frameTimes).toEqual([2, 3, 4].map((h) => T0 + h * HOUR));
		await s.finish('f1');
		expect(s.clouds.frameTimes).toEqual([1, 2, 3].map((h) => T0 + h * HOUR));
		s.feed.stop(); s.clouds.dispose();
	});

	it('reads no index again when scrubbing back to a day within a minute', async () => {
		const wall = { now: T0 };
		const s = scrub([0], wall);
		s.feed.setTime(T0); await vi.waitFor(() => expect(s.loads).toHaveLength(1));
		s.feed.setTime(T0 - 3 * 24 * HOUR); await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledTimes(2));
		s.feed.setTime(T0); await vi.waitFor(() => expect(s.loads).toHaveLength(2));
		expect(s.fetchFn.mock.calls.map(([url]) => String(url).slice(-15))).toEqual(['2026-07-15.json', '2026-07-12.json']);
		s.feed.stop(); s.clouds.dispose();
	});
});

it('keeps the live frames on screen when replay opens, then hands them back', async () => {
	const s = setup([-1, 0, 1]);
	const liveTextures: Texture[] = [];
	const live = { start: vi.fn(() => {
		for (const h of [-1, 0, 1]) {
			const texture = new Texture({ width: 2048, height: 1024 });
			liveTextures.push(texture); s.clouds.setFrame({ texture, time: T0 + h * HOUR });
		}
	}), stop: vi.fn(), settled: true, attribution: 'Live' };
	const playback = new CloudPlayback(s.clouds, live, s.feed);
	playback.update('live', T0); s.clouds.setTime(T0);
	const disposals = liveTextures.map((texture) => vi.spyOn(texture, 'dispose'));
	playback.update('replay', T0); s.clouds.setTime(T0);
	expect(s.clouds.mesh.visible).toBe(true);
	await s.feed.idle();
	expect(s.load).not.toHaveBeenCalled();
	expect(disposals.every((dispose) => dispose.mock.calls.length === 0)).toBe(true);
	expect(s.clouds.frameTime).toBe(T0);
	playback.update('live', T0);
	expect(disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
	expect(playback.status.attribution).toBe('Live');
	playback.dispose(); s.clouds.dispose();
});

it('drops live frames the archive does not list once its indices are known', async () => {
	const s = setup([0]);
	const texture = new Texture({ width: 2048, height: 1024 });
	const dispose = vi.spyOn(texture, 'dispose');
	s.clouds.setFrame({ texture, time: T0 + 2 * HOUR });
	s.feed.setTime(T0); await s.feed.idle();
	expect(dispose).toHaveBeenCalledOnce();
	expect(s.clouds.frameTimes).toEqual([T0]);
	s.feed.stop(); s.clouds.dispose();
});

it('keeps the live frames while the archive index is unavailable', async () => {
	const s = setup([0]);
	s.fetchFn.mockImplementation(async () => new Response(null, { status: 429 }));
	const texture = new Texture({ width: 2048, height: 1024 });
	s.clouds.setFrame({ texture, time: T0 });
	s.feed.setTime(T0); await s.feed.idle(); s.clouds.setTime(T0);
	expect(s.clouds.frameTime).toBe(T0);
	s.feed.stop(); s.clouds.dispose();
});

it('bounds streamed responses and cancels over-limit bodies', async () => {
	let cancelled = false;
	const body = new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array(10)); },
		cancel() { cancelled = true; },
	});
	await expect(boundedBody(new Response(body), 15)).rejects.toThrow('too large');
	expect(cancelled).toBe(true);
	expect(await boundedBody(new Response('okay'), 4)).toEqual(new TextEncoder().encode('okay'));
});
