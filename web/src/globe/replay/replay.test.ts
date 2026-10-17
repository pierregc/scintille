import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../../contract/types';
import { SceneData } from '../archive';
import { SceneClock } from '../clock';
import { kmToWorld, poseAt } from '../flight';
import type { LiveFeed } from '../live';
import { LiveClient } from '../live/client';
import { FlashRing } from '../live/ring';
import { FakeFeed, FakeVisibility } from '../live/testing';
import { latLonToVector } from '../sun';
import { StormReplay } from './index';
import { frameStorm, stormCap } from './framing';

const detail = fixture as StormDetail;

describe('storm framing', () => {
	it.each([16 / 9, 9 / 16])('fits small, large, dateline, polar and offshore bounds at aspect %s', (aspect) => {
		for (const bounds of [fixture.bounds,
			{ west: -100, east: -70, south: 0, north: 30 },
			{ west: 175, east: -175, south: -5, north: 5 },
			{ west: -120, east: 120, south: 83, north: 90 },
			{ west: -35, east: -32, south: -12, north: -10 }]) {
			const view = frameStorm(bounds, 35, aspect);
			expect(view.duration).toBeLessThan(4000);
			const camera = new PerspectiveCamera(35, aspect, 1e-5, 1000);
			const pose = poseAt(view.lat, view.lon, kmToWorld(view.altitude, 1), view.tilt, 1);
			camera.position.copy(pose.position);
			camera.quaternion.copy(pose.quaternion);
			camera.updateMatrixWorld();
			const width = bounds.east >= bounds.west ? bounds.east - bounds.west : bounds.east + 360 - bounds.west;
			for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
				const lat = bounds.south + (bounds.north - bounds.south) * i / 10;
				const lon = bounds.west + width * j / 10;
				const point = new Vector3(...latLonToVector(lat, lon)).project(camera);
				expect(Math.max(Math.abs(point.x), Math.abs(point.y))).toBeLessThan(0.64);
			}
		}
	});
	it('keeps dateline centering local and uses globe framing for worldwide bounds', () => {
		expect(Math.abs(stormCap({ west: 179, east: -179, south: -2, north: 2 }).lon)).toBe(180);
		expect(frameStorm({ west: -180, east: 180, south: -90, north: 90 }, 35, 1).tilt).toBe(0);
	});
});

describe('production replay entry', () => {
	it('loads real-contract fixture data, starts the scene and returns to a fresh live feed', async () => {
		const feed = new FakeFeed();
		await feed.publish(200, 30, 2);
		let starts = 0;
		const startLive = (ring: FlashRing): LiveFeed => {
			starts++;
			const client = new LiveClient({ baseUrl: 'https://feed.test/', ring, fetch: feed.fetch, visibility: new FakeVisibility() });
			client.start();
			return { ring, client, stop: () => client.stop() };
		};
		const clock = new SceneClock(() => 200_000);
		const data = new SceneData(clock, startLive(new FlashRing(8)), startLive);
		const chunk = new Uint8Array(await readFile(new URL(`../../../../fixtures/${fixture.replay.chunks[0].path}`, import.meta.url)));
		const fetchFn: typeof fetch = async (input) => String(input).endsWith('.json') ? Response.json(fixture) : new Response(chunk);
		const controls = { flyTo: vi.fn().mockResolvedValue(true), cancelFlight: vi.fn() };
		const replay = new StormReplay({ live: () => data.live(), openStorm: (base, slug, speed) => data.openStorm(base, slug, speed, fetchFn) }, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 16 / 9 }));
		try {
			await data.liveClient.idle();
			expect(await replay.open(fixture.storm.slug)).toBe(true);
			expect(clock.mode).toBe('replay');
			expect(clock.time()).toBe(Date.parse(fixture.storm.t_start));
			expect(clock.playing).toBe(true);
			expect(clock.speed).toBe(60);
			expect(data.ring.size).toBe(3);
			expect(replay.state.selected?.storm.slug).toBe(fixture.storm.slug);
			await replay.live();
			await data.liveClient.idle();
			expect(clock.mode).toBe('live');
			expect(replay.state.selected).toBeNull();
			expect(starts).toBe(2);
			expect(data.ring.size).toBe(2);
		} finally { replay.dispose(); data.dispose(); }
	});

	it('keeps the current selection on failure and ignores superseded results', async () => {
		const clock = new SceneClock(() => 0);
		const data = { openStorm: vi.fn().mockResolvedValue(detail), live: vi.fn().mockResolvedValue(undefined) };
		const controls = { flyTo: vi.fn().mockResolvedValue(false), cancelFlight: vi.fn() };
		const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
		expect(await replay.open(detail.storm.slug)).toBe(true); // Interrupted flight keeps the loaded replay.
		data.openStorm.mockRejectedValueOnce(new Error('offline'));
		expect(await replay.open('unavailable')).toBe(false);
		expect(replay.state.selected).toBe(detail);
		expect(replay.state.error).toContain('could not be opened');
		let resolve!: (value: StormDetail) => void;
		data.openStorm.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const pending = replay.open('slow');
		await replay.live();
		resolve(detail);
		expect(await pending).toBe(false);
		expect(replay.state.selected).toBeNull();
		expect(controls.flyTo).toHaveBeenCalledTimes(1);
		replay.dispose();
	});
});
