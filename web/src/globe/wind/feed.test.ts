import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MAX_WIND_FIELDS, WIND_POLL_INTERVAL_MS, WindFeed, type WindFeedOptions } from './feed';
import type { WindSource } from './manifest';
import { WIND_LOOK_KEY } from './preference';
import { archiveWindManifest, ATTRIBUTION, HOUR, liveWindManifest, windFrame } from './testing';
import type { WindField, WindLook } from './types';

const BASE = 'https://data.example/';
const LIVE = `${BASE}live/wind/manifest.json`;
const NOW = Date.UTC(2026, 10, 21, 12, 10);
const H0 = Date.UTC(2026, 10, 21, 12);
const at = (hours: number) => H0 + hours * HOUR;
const dayUrl = (day: string) => `${BASE}archive/wind/manifests/${day}.json`;

class FakeLayer {
	look: WindLook | null = null;
	a: WindField | null = null;
	b: WindField | null = null;
	mix = 0;
	setLook(look: WindLook | null) { this.look = look; }
	setFields(a: WindField | null, b: WindField | null, mix: number) {
		this.a = a;
		this.b = b;
		this.mix = mix;
	}
}

interface Setup {
	look?: WindLook | null;
	served?: Record<string, unknown>;
	now?: () => number;
	options?: Partial<WindFeedOptions>;
}

function setup({ look = 'jet', served = { [LIVE]: liveWindManifest([-5, -4, -3, -2, -1, 0, 1].map(at)) }, now = () => NOW, options }: Setup = {}) {
	const layer = new FakeLayer();
	const requests: string[] = [];
	const loads: string[] = [];
	const live = new Set<Texture>();
	const fetchFn = vi.fn(async (input: string | URL | Request) => {
		requests.push(String(input));
		const body = served[String(input)];
		return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
	});
	const load = vi.fn(async (source: WindSource): Promise<WindField> => {
		loads.push(source.url);
		const texture = new Texture();
		live.add(texture);
		texture.addEventListener('dispose', () => live.delete(texture));
		return { time: source.time, level: source.level, texture, scaleMs: source.scaleMs };
	});
	const storage = new Map<string, string>(look ? [[WIND_LOOK_KEY, look]] : []);
	const feed = new WindFeed({
		baseUrl: BASE,
		layer,
		now,
		storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value) },
		fetch: fetchFn,
		load,
		random: () => 0.5,
		...options,
	});
	/** Lets every download finish, then draws a frame. */
	const settle = async (scene: number, wall = 0) => {
		feed.setTime(scene, wall);
		await feed.idle();
		feed.setTime(scene, wall);
	};
	return { feed, layer, requests, loads, live, storage, fetchFn, load, settle };
}

describe('WindFeed', () => {
	it('starts off and downloads nothing at all while off', async () => {
		const { feed, layer, fetchFn, load, settle } = setup({ look: null });
		expect(feed.look).toBeNull();
		expect(layer.look).toBeNull();
		await settle(NOW);
		await settle(at(-30));
		expect(fetchFn).not.toHaveBeenCalled();
		expect(load).not.toHaveBeenCalled();
		expect(layer.a).toBeNull();
	});

	it('restores the saved look and remembers a new one', () => {
		const { feed, layer, storage } = setup({ look: 'surface' });
		expect(feed.look).toBe('surface');
		expect(layer.look).toBe('surface');
		feed.setLook('jet');
		expect(storage.get(WIND_LOOK_KEY)).toBe('jet');
		feed.setLook(null);
		expect(storage.get(WIND_LOOK_KEY)).toBe('off');
		expect(layer.look).toBeNull();
	});

	it('blends the two frames around the scene time', async () => {
		const { feed, layer, requests, settle } = setup();
		await settle(at(20 / 60));
		expect(requests).toEqual([LIVE]);
		expect(layer.a?.time).toBe(at(0));
		expect(layer.b?.time).toBe(at(1));
		expect(layer.mix).toBeCloseTo(1 / 3, 6);
		expect(feed.shown).toBe(true);
		expect(feed.attribution).toBe(ATTRIBUTION);
	});

	it('downloads only the level of the chosen look, the pair first', async () => {
		const { feed, layer, loads, live, settle } = setup();
		await settle(at(0.25));
		expect(loads.slice(0, 2)).toEqual([`${BASE}archive/wind/250hPa/2026/11/21/20261121T12Z-1a2b3c4d.webp`, `${BASE}archive/wind/250hPa/2026/11/21/20261121T13Z-1a2b3c4d.webp`]);
		expect(loads.every((url) => url.includes('/250hPa/'))).toBe(true);
		expect(layer.a?.level).toBe('250hPa');
		const jet = [...live];

		feed.setLook('surface');
		expect(layer.a).toBeNull();
		expect(jet.some((t) => live.has(t))).toBe(false);
		loads.length = 0;
		await settle(at(0.25));
		expect(loads.length).toBeGreaterThan(0);
		expect(loads.every((url) => url.includes('/10m/'))).toBe(true);
		expect(layer.a?.level).toBe('10m');
	});

	it('turning off cancels, hides and frees every texture', async () => {
		const { feed, layer, live, fetchFn, settle } = setup();
		await settle(at(0.5));
		expect(live.size).toBeGreaterThan(0);
		feed.setLook(null);
		expect(layer.a).toBeNull();
		expect(live.size).toBe(0);
		const calls = fetchFn.mock.calls.length;
		await settle(at(0.5));
		expect(fetchFn.mock.calls.length).toBe(calls);
	});

	it('hides more than 3 hours away from every frame', async () => {
		const { layer, loads, settle } = setup({ served: { [LIVE]: liveWindManifest([at(-6), at(-5)]) } });
		await settle(at(-2.5));
		expect(layer.a?.time).toBe(at(-5));
		expect(layer.b?.time).toBe(at(-5));
		expect(layer.mix).toBe(0);
		await settle(at(-1.9));
		expect(layer.a).toBeNull();
		expect(loads).toHaveLength(1);
	});

	it('shows the nearest frame alone across a gap, never a mix of both', async () => {
		const { layer, settle } = setup({ served: { [LIVE]: liveWindManifest([at(-4), at(0)]) } });
		await settle(at(-2.5));
		expect([layer.a?.time, layer.mix]).toEqual([at(-4), 0]);
		await settle(at(-1.5));
		expect([layer.a?.time, layer.mix]).toEqual([at(0), 0]);
	});

	it('keeps a few textures on the GPU as the scene time moves, and frees them all on dispose', async () => {
		const { feed, live, settle } = setup();
		for (let minutes = -300; minutes <= 60; minutes += 20) {
			await settle(at(minutes / 60));
			expect(live.size).toBeLessThanOrEqual(MAX_WIND_FIELDS);
		}
		feed.dispose();
		expect(live.size).toBe(0);
	});

	it('eases into a frame that arrives after the scene shows', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { layer, feed } = setup({
			options: {
				load: async (source) => {
					if (source.time === at(1)) await gate;
					return { time: source.time, level: source.level, texture: new Texture(), scaleMs: source.scaleMs };
				},
			},
		});
		const scene = at(0.5);
		feed.setTime(scene, 0);
		await vi.waitFor(() => { feed.setTime(scene, 0); expect(layer.a?.time).toBe(at(0)); });
		expect(layer.mix).toBe(0);
		release();
		await feed.idle();
		feed.setTime(scene, 0);
		expect(layer.b?.time).toBe(at(1));
		expect(layer.mix).toBe(0);
		feed.setTime(scene, 600);
		expect(layer.mix).toBeGreaterThan(0.1);
		expect(layer.mix).toBeLessThan(0.5);
		feed.setTime(scene, 20_000);
		expect(layer.mix).toBeCloseTo(0.5, 3);
	});

	it('polls the live manifest every few minutes and picks up new frames', async () => {
		let now = NOW;
		const served: Record<string, unknown> = { [LIVE]: liveWindManifest([at(0)]) };
		const { requests, layer, settle } = setup({ served, now: () => now });
		await settle(at(0.5));
		expect(layer.a?.time).toBe(at(0));
		served[LIVE] = liveWindManifest([at(0), at(1)]);
		now += WIND_POLL_INTERVAL_MS - 1000;
		await settle(at(0.5));
		expect(requests).toEqual([LIVE]);
		now += 1000;
		await settle(at(0.5), 60_000);
		expect(requests).toEqual([LIVE, LIVE]);
		expect(layer.b?.time).toBe(at(1));
	});

	it('swaps a frame for a newer forecast of the same time without a gap', async () => {
		let now = NOW;
		const served: Record<string, unknown> = { [LIVE]: liveWindManifest([at(0)]) };
		const { layer, live, settle } = setup({ served, now: () => now });
		await settle(at(0));
		const first = layer.a?.texture;
		served[LIVE] = { ...liveWindManifest([]), frames: [windFrame(at(0), '../../archive/wind/', '9f8e7d6c')] };
		now += WIND_POLL_INTERVAL_MS;
		await settle(at(0));
		expect(layer.a?.texture).not.toBe(first);
		expect(first && live.has(first)).toBe(false);
		expect(live.size).toBe(1);
	});

	it('backs off after a failed poll', async () => {
		let now = NOW;
		const errors: unknown[] = [];
		const { requests, settle } = setup({ served: {}, now: () => now, options: { onError: (e) => errors.push(e) } });
		await settle(NOW);
		expect(requests).toEqual([LIVE, dayUrl('2026-11-21')]);
		expect(errors).toHaveLength(1);
		now += 4000;
		await settle(NOW);
		expect(requests.filter((r) => r === LIVE)).toHaveLength(2);
	});

	it('reads the daily indexes around a scene time older than the live window', async () => {
		const served = {
			[LIVE]: liveWindManifest([-5, -4, -3, -2, -1, 0, 1].map(at)),
			[dayUrl('2026-11-17')]: archiveWindManifest('2026-11-17', [21, 22, 23].map((h) => Date.UTC(2026, 10, 17, h))),
			[dayUrl('2026-11-18')]: archiveWindManifest('2026-11-18', [0, 1, 2].map((h) => Date.UTC(2026, 10, 18, h))),
		};
		const { feed, layer, requests, loads, settle } = setup({ served });
		const scene = Date.UTC(2026, 10, 17, 23, 30);
		await settle(scene);
		expect(requests).toEqual([dayUrl('2026-11-17'), dayUrl('2026-11-18')]);
		expect(layer.a?.time).toBe(Date.UTC(2026, 10, 17, 23));
		expect(layer.b?.time).toBe(Date.UTC(2026, 10, 18, 0));
		expect(layer.mix).toBeCloseTo(0.5, 6);
		expect(loads[0]).toBe(`${BASE}archive/wind/250hPa/2026/11/17/20261117T23Z-1a2b3c4d.webp`);
		expect(feed.attribution).toBe(ATTRIBUTION);

		requests.length = 0;
		await settle(at(-1));
		expect(requests).toEqual([LIVE]);
	});

	it('switches to the archive just before the live window, and never asks for days to come', async () => {
		const served = {
			[LIVE]: liveWindManifest([-5, -4, -3, -2, -1, 0, 1].map(at)),
			[dayUrl('2026-11-21')]: archiveWindManifest('2026-11-21', [5, 6, 7, 8].map((h) => Date.UTC(2026, 10, 21, h))),
		};
		const { feed, layer, requests, settle } = setup({ served });
		await settle(at(-4.5));
		expect(requests).toEqual([LIVE]);
		await settle(at(-5.5));
		expect(requests).toEqual([LIVE, dayUrl('2026-11-21')]);
		feed.setTime(at(-5.5), 20_000);
		expect([layer.a?.time, layer.b?.time]).toEqual([at(-6), at(-5)]);
		expect(layer.mix).toBeCloseTo(0.5, 6);
	});

	it('skips expired archive frames', async () => {
		const day = '2026-10-22';
		const times = [10, 11].map((h) => Date.UTC(2026, 9, 22, h));
		const served = { [dayUrl(day)]: archiveWindManifest(day, times, (t) => (t === times[0] ? NOW - 1 : NOW + HOUR)) };
		const { layer, loads, settle } = setup({ served });
		await settle(Date.UTC(2026, 9, 22, 10, 30));
		expect(loads).toHaveLength(1);
		expect(layer.a?.time).toBe(times[1]);
	});

	it('retries a texture that failed, later', async () => {
		let now = NOW;
		let fail = true;
		const { layer, settle } = setup({
			now: () => now,
			options: {
				load: async (source) => {
					if (fail && source.time === at(0)) throw new Error('offline');
					return { time: source.time, level: source.level, texture: new Texture(), scaleMs: source.scaleMs };
				},
			},
		});
		await settle(at(0));
		expect(layer.a?.time).not.toBe(at(0));
		fail = false;
		now += 61_000;
		await settle(at(0), 60_000);
		expect(layer.a?.time).toBe(at(0));
	});
});
