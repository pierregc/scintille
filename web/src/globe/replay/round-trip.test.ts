import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail } from '../../contract/types';
import { SceneClock } from '../clock';
import { createClouds } from '../clouds';
import { CloudPlayback } from '../clouds/playback';
import { StormReplay } from './index';
import { ReplayNavigation } from './navigation';
import { StormTrack } from './track';

const HOUR = 3_600_000;
const WALL = Date.parse('2026-10-28T12:00:00Z');

function setup() {
	let url = new URL('https://scintille.app/');
	let pop = () => {};
	const clock = new SceneClock(() => WALL);
	const textures: { texture: Texture; disposed: boolean }[] = [];
	const frame = (time: number) => {
		const texture = new Texture({ width: 4, height: 2 });
		const entry = { texture, disposed: false };
		texture.addEventListener('dispose', () => (entry.disposed = true));
		textures.push(entry);
		return { texture, time };
	};
	const clouds = createClouds(16, { storage: null });
	const archived = new Set<number>();
	const live = { start: vi.fn(() => clouds.setFrame(frame(WALL - HOUR))), stop: vi.fn(), settled: true, attribution: null };
	const archive = {
		setTime: vi.fn((time: number) => {
			const hour = Math.floor(time / HOUR) * HOUR;
			if (!archived.has(hour)) { archived.add(hour); clouds.setFrame(frame(hour)); }
		}),
		stop: vi.fn(() => { archived.clear(); clouds.retainFrames([]); }),
		settled: true,
		attribution: null,
	};
	const playback = new CloudPlayback(clouds, live, archive);
	const track = new StormTrack();
	const data = {
		openStorm: vi.fn(async (_base: string, _slug: string, speed: number) => {
			clock.replay(Date.parse(fixture.storm.t_start), speed);
			return fixture as StormDetail;
		}),
		live: vi.fn(async () => { clock.live(); }),
	};
	const controls = { cancelFlight: vi.fn(), view: () => ({ lat: 28.5, lon: -81.3, altitude: 2000, tilt: 0 }), flyTo: vi.fn(async () => true) };
	const replay = new StormReplay(data, clock, controls, 'https://feed.test/', () => ({ fov: 35, aspect: 1 }));
	const navigation = new ReplayNavigation(replay, clock, controls, {
		url: () => url,
		write: (next) => { url = next; },
		onPop: (listener) => { pop = listener; return () => {}; },
	});
	/** One animation frame, in the order the app draws it. */
	const draw = () => {
		const now = clock.time();
		track.setStorm(clock.mode === 'replay' ? replay.state.selected : null);
		track.setTime(now);
		playback.update(clock.mode, now);
		clouds.setTime(now);
	};
	return {
		clock, clouds, replay, navigation, track, live, archive, draw, textures,
		url: () => url,
		go: async (href: string) => { url = new URL(href); pop(); await navigation.restore(); draw(); },
	};
}

describe('live, replay, live round trip', () => {
	it('restores time, layers and the selected storm each way', async () => {
		const x = setup();
		x.draw();
		expect(x.clock.time()).toBe(WALL);
		expect(x.clouds.frameTime).toBe(WALL - HOUR);
		expect(x.track.group.visible).toBe(false);

		await x.replay.open(fixture.storm.slug);
		x.clock.pause();
		x.clock.seek(Date.parse('2026-07-15T18:01:30Z'));
		x.clouds.setVisible(false);
		x.draw();
		const stormUrl = x.url().href;
		expect(x.clouds.frameTime).toBeNull();
		expect(x.track.group.visible).toBe(true);
		x.clouds.setVisible(true);
		x.draw();
		expect(x.clouds.frameTime).toBe(Date.parse('2026-07-15T18:00:00Z'));

		await x.replay.live();
		x.draw();
		expect(x.clock.mode).toBe('live');
		expect(x.clock.time()).toBe(WALL);
		expect(x.clock.speed).toBe(1);
		expect(x.replay.state.selected).toBeNull();
		expect(x.url().searchParams.has('storm')).toBe(false);
		expect(x.track.group.visible).toBe(false);
		expect(x.clouds.visible).toBe(true);
		expect(x.clouds.frameTime).toBe(WALL - HOUR);

		await x.go(stormUrl);
		expect(x.clock.mode).toBe('replay');
		expect(x.clock.time()).toBe(Date.parse('2026-07-15T18:01:30Z'));
		expect(x.clock.playing).toBe(false);
		expect(x.replay.state.selected?.storm.slug).toBe(fixture.storm.slug);
		expect(x.track.group.visible).toBe(true);
		expect(x.clouds.frameTime).toBe(Date.parse('2026-07-15T18:00:00Z'));

		await x.go('https://scintille.app/');
		expect(x.clock.mode).toBe('live');
		expect(x.clouds.frameTime).toBe(WALL - HOUR);
		expect(x.textures.filter((t) => !t.disposed)).toHaveLength(1);
		expect(x.live.start).toHaveBeenCalledTimes(3);
	});
});
