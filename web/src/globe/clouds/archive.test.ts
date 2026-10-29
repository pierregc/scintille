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

	it('discovers just three day indices and loads nearby historical textures for scene time', async () => {
		const s = setup();
		s.feed.setTime(T0 + HOUR);
		await s.feed.idle();
		s.clouds.setTime(T0 + HOUR);
		expect(s.requests).toEqual(['2026-07-14', '2026-07-15', '2026-07-16'].map((d) => `${BASE}archive/clouds/manifests/${d}.json`));
		expect(s.clouds.frameTime).toBe(T0 + HOUR);
		expect(s.feed.settled).toBe(true);
		expect(s.feed.attribution).toContain('NOAA');
		expect(s.textures).toHaveLength(3);
		s.feed.stop(); s.clouds.dispose();
	});

	it('waits for every day before loading, so a frame of the next day is not skipped', async () => {
		const s = setup([3, 4, 5]);
		let nextDay: (response: Response) => void = () => {};
		s.fetchFn.mockImplementation(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith('2026-07-16.json')) return new Promise<Response>((resolve) => { nextDay = resolve; });
			return url.endsWith('2026-07-15.json') ? Response.json(manifest('2026-07-15', [3, 4, 5])) : new Response(null, { status: 404 });
		});
		const time = T0 + 5.75 * HOUR;
		s.feed.setTime(time);
		await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledTimes(3));
		s.feed.setTime(time);
		expect(s.load).not.toHaveBeenCalled();
		nextDay(Response.json(manifest('2026-07-16', [6])));
		await s.feed.idle();
		expect(s.load.mock.calls.map(([, at]) => (at - T0) / HOUR)).toEqual([6, 5, 4]);
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
		expect(s.requests).toHaveLength(0); expect(s.fetchFn).toHaveBeenCalledTimes(3);
		wall += 60_000;
		s.fetchFn.mockImplementation(async () => Response.json(manifest('2026-07-15', [0])));
		s.feed.setTime(T0); await s.feed.idle();
		expect(s.fetchFn).toHaveBeenCalledTimes(6); expect(s.load).toHaveBeenCalledOnce();
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
		await vi.waitFor(() => expect(s.fetchFn).toHaveBeenCalledTimes(6));
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
		expect(s.fetchFn).toHaveBeenCalledTimes(3);
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

it('releases owned textures on live/replay/live transitions and disposal', async () => {
	const s = setup([0]);
	const liveTextures: Texture[] = [];
	const live = { start: vi.fn(() => {
		const texture = new Texture({ width: 2048, height: 1024 });
		liveTextures.push(texture); s.clouds.setFrame({ texture, time: T0 });
	}), stop: vi.fn(), settled: true, attribution: 'Live' };
	const playback = new CloudPlayback(s.clouds, live, s.feed);
	playback.update('live', T0);
	const liveDisposed = vi.spyOn(liveTextures[0], 'dispose');
	playback.update('replay', T0); await s.feed.idle();
	expect(liveDisposed).toHaveBeenCalledOnce();
	const historicalDisposed = vi.spyOn(s.textures[0], 'dispose');
	playback.update('live', T0);
	expect(historicalDisposed).toHaveBeenCalledOnce();
	expect(playback.status.attribution).toBe('Live');
	const lastDisposed = vi.spyOn(liveTextures[1], 'dispose');
	playback.dispose(); expect(lastDisposed).toHaveBeenCalledOnce();
	s.clouds.dispose();
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
