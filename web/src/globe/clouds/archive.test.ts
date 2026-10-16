import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/archive/clouds/manifests/2026-07-15.json';
import { ArchiveCloudFeed } from './archive';
import type { CloudFrame } from './frame';
import { createClouds } from './index';
import { CloudPlayback } from './playback';
import { boundedBody } from './response';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 6, 15, 18);
const BASE = 'https://example.test/';

function manifest(day: string, hours: number[]) {
	return {
		...fixture, day,
		frames: hours.map((h) => ({ ...fixture.frames[0], time: new Date(T0 + h * HOUR).toISOString(),
			textures: { '2k': { ...fixture.frames[0].textures['2k'], path: `../2k/2026/07/15/f${h}.webp` } },
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

it('switches cloud owners and clears textures on live/replay/live transitions', () => {
	const clouds = { visible: true, retainFrames: vi.fn() };
	const live = { start: vi.fn(), stop: vi.fn(), settled: true, attribution: 'Live' };
	const archive = { setTime: vi.fn(), stop: vi.fn(), settled: true, attribution: 'Historical' };
	const playback = new CloudPlayback(clouds, live, archive);
	playback.update('live', T0); playback.update('replay', T0 - 10 * HOUR);
	expect(playback.status.attribution).toBe('Historical');
	expect(archive.setTime).toHaveBeenCalledWith(T0 - 10 * HOUR);
	playback.update('live', T0); expect(playback.status.attribution).toBe('Live');
	expect(clouds.retainFrames).toHaveBeenCalledTimes(3);
	playback.dispose();
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
