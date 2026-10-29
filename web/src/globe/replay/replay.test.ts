import { readFile } from 'node:fs/promises';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../../contract/types';
import { SceneData } from '../archive';
import { ReplayExpiredError } from '../archive/storm';
import { SceneClock } from '../clock';
import { kmToWorld, poseAt } from '../flight';
import type { LiveFeed } from '../live';
import { LiveClient } from '../live/client';
import { FlashRing } from '../live/ring';
import { FakeFeed, FakeVisibility } from '../live/testing';
import { latLonToVector } from '../sun';
import { END_GRACE_MS, StormReplay } from './index';
import { frameStorm, GRAZE, REPLAY_FRAME, stormCap } from './framing';

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
				expect(Math.max(Math.abs(point.x), Math.abs(point.y))).toBeLessThan(REPLAY_FRAME.viewportFraction + 0.02);
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
		const clock = new SceneClock(() => Date.UTC(2027, 0, 1));
		const data = new SceneData(clock, startLive(new FlashRing(8)), startLive);
		const chunk = new Uint8Array(await readFile(new URL(`../../../../fixtures/${fixture.replay.chunks[0].path}`, import.meta.url)));
		const fetchFn: typeof fetch = async (input) => String(input).endsWith('.json') ? Response.json(fixture) : new Response(chunk);
		const controls = { flyTo: vi.fn().mockResolvedValue(true), cancelFlight: vi.fn(), isAt: () => false };
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
		const clock = new SceneClock(() => Date.UTC(2027, 0, 1));
		const data = { openStorm: vi.fn().mockImplementation(async () => { clock.replay(Date.parse(detail.storm.t_start), 60); return detail; }), live: vi.fn().mockResolvedValue(undefined) };
		const controls = { flyTo: vi.fn().mockResolvedValue(false), cancelFlight: vi.fn(), isAt: () => false };
		const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
		expect(await replay.open(detail.storm.slug)).toBe(true); // Interrupted flight keeps the loaded replay.
		data.openStorm.mockRejectedValueOnce(new Error('offline'));
		expect(await replay.open('unavailable')).toBe(false);
		expect(replay.state.selected).toBe(detail);
		expect(replay.state.error).toContain('could not be opened');
		data.openStorm.mockRejectedValueOnce(new ReplayExpiredError());
		expect(await replay.open('expired')).toBe(false);
		expect(replay.state.error).toContain('kept 60 days');
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

it('flies to the horizon view of the open storm and back to its frame', async () => {
	const clock = new SceneClock(() => Date.UTC(2027, 0, 1));
	const data = { openStorm: vi.fn().mockImplementation(async () => { clock.replay(Date.parse(detail.storm.t_start), 60); return detail; }), live: vi.fn().mockResolvedValue(undefined) };
	let at: unknown;
	const controls = { cancelFlight: vi.fn(), isAt: (pose: unknown) => pose === at, flyTo: vi.fn().mockImplementation(async (pose) => { at = pose; return true; }) };
	const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
	try {
		expect(await replay.graze(true)).toBe(false);
		await replay.open(detail.storm.slug);
		expect(replay.grazing).toBe(false);
		expect(await replay.graze(true)).toBe(true);
		expect(controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ tilt: GRAZE.tilt }));
		expect(replay.grazing).toBe(true);
		at = null;
		expect(replay.grazing).toBe(false);
		await replay.graze(true);
		await replay.graze(false);
		expect(controls.flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ tilt: REPLAY_FRAME.tilt }));
		expect(replay.grazing).toBe(false);
		await replay.graze(true);
		await replay.live();
		expect(replay.grazing).toBe(false);
	} finally { replay.dispose(); }
});

it('holds the start instant during the camera flight before autoplay so a short storm is not skipped', async () => {
	let wall = Date.UTC(2027, 0, 1);
	const clock = new SceneClock(() => wall);
	const start = Date.parse(fixture.storm.t_start);
	let finish!: (arrived: boolean) => void;
	const controls = { cancelFlight: vi.fn(), isAt: () => false, flyTo: vi.fn().mockImplementation(() => new Promise<boolean>((done) => { finish = done; })) };
	const data = { openStorm: vi.fn().mockImplementation(async () => { clock.replay(start, 60); return detail; }), live: vi.fn().mockResolvedValue(undefined) };
	const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
	const opening = replay.open(fixture.storm.slug);
	await Promise.resolve();
	wall += 2800;
	expect(clock.time()).toBe(start);
	expect(clock.playing).toBe(false);
	finish(true);
	await opening;
	expect(clock.playing).toBe(true);
	expect(clock.time()).toBe(start);
	wall += 100;
	expect(clock.time()).toBe(start + 6000);
	replay.dispose();
});

it('restarts an ended replay in place and returns to live once it has played past the end', async () => {
	let wall = Date.UTC(2027, 0, 1);
	const clock = new SceneClock(() => wall);
	const start = Date.parse(detail.storm.t_start);
	const end = Date.parse(detail.storm.t_end);
	const data = { openStorm: vi.fn().mockImplementation(async () => { clock.replay(start, 60); return detail; }), live: vi.fn().mockImplementation(async () => clock.live()) };
	const controls = { flyTo: vi.fn().mockResolvedValue(true), cancelFlight: vi.fn(), isAt: () => false };
	const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
	try {
		await replay.open(detail.storm.slug);
		expect(replay.ended).toBe(false);
		clock.seek(end + 1);
		expect(replay.ended).toBe(true);
		replay.update();
		wall += END_GRACE_MS - 1;
		replay.update();
		expect(clock.mode).toBe('replay');
		clock.pause();
		wall += 60_000;
		replay.update();
		expect(clock.mode).toBe('replay');
		replay.restart();
		expect(clock.time()).toBe(start);
		expect(clock.playing).toBe(true);
		expect(replay.ended).toBe(false);
		expect(controls.flyTo).toHaveBeenCalledTimes(1);
		clock.seek(end + 3_600_000);
		replay.update();
		wall += END_GRACE_MS;
		replay.update();
		expect(data.live).toHaveBeenCalledTimes(1);
		expect(clock.mode).toBe('live');
		expect(replay.state.selected).toBeNull();
		expect(replay.ended).toBe(false);
	} finally { replay.dispose(); }
});
