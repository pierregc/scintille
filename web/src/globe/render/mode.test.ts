import { PerspectiveCamera } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SceneClock } from '../clock';
import { createRenderHandle, type RenderDeps } from './mode';
import { parseRenderParams } from './params';

const params = parseRenderParams('?start=2026-07-15T18:30:00Z&end=2026-07-15T18:31:00Z&frames=4&lat=0&lon=0&alt=6371');

function fakeClouds(failures = 0) {
	let frameLoaded = false;
	let polling: Promise<void> | undefined;
	const clouds = {
		running: false,
		failures,
		settled: false,
		get frameLoaded() {
			return frameLoaded;
		},
		start: vi.fn(() => {
			clouds.running = true;
			void clouds.poll();
		}),
		poll: vi.fn(() => {
			if (polling || !clouds.running) return Promise.resolve();
			polling = new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
				frameLoaded = true;
				clouds.settled = true;
			});
			return polling;
		}),
		idle: () => polling ?? Promise.resolve(),
		stop: vi.fn(() => {
			clouds.running = false;
		}),
	};
	return clouds;
}

function setup(
	overrides: {
		failures?: number;
		cloudFailures?: number;
		covered?: (time: number) => boolean;
		loaded?: () => boolean;
	} = {},
) {
	const clock = new SceneClock(() => 0);
	const camera = new PerspectiveCamera();
	const times: number[] = [];
	const stop = vi.fn();
	const clouds = fakeClouds(overrides.cloudFailures);
	const deps: RenderDeps = {
		clock,
		camera,
		radius: 1,
		feed: {
			client: {
				idle: () => Promise.resolve(),
				failures: overrides.failures ?? 0,
				covers: overrides.covered ?? (() => true),
			} as unknown as RenderDeps['feed']['client'],
			stop,
		},
		clouds,
		loaded: overrides.loaded ?? (() => true),
		draw: () => times.push(clock.time()),
		timeoutMs: 100,
	};
	return { handle: createRenderHandle(params, deps), clock, camera, times, stop, clouds };
}

describe('createRenderHandle', () => {
	it('freezes the clock until a frame is drawn', () => {
		const { clock, times } = setup();
		expect(clock.mode).toBe('render');
		expect(times).toEqual([]);
	});

	it('draws each frame at its scene time, in any order', () => {
		const { handle, times } = setup();
		handle.frame(3);
		handle.frame(0);
		handle.frame(3);
		expect(times).toEqual([params.start + 45_000, params.start, params.start + 45_000]);
	});

	it('places the camera above the requested point', () => {
		const { handle, camera } = setup();
		handle.frame(0);
		expect(camera.position.x).toBeCloseTo(2);
		expect(camera.position.y).toBeCloseTo(0);
		expect(camera.position.z).toBeCloseTo(0);
	});

	it('stops polling once the feed is loaded', async () => {
		const { handle, stop } = setup();
		await handle.ready();
		expect(stop).toHaveBeenCalledOnce();
	});

	it('loads the cloud frames before the first frame and stops polling them', async () => {
		const { handle, clouds } = setup();
		await handle.ready();
		expect(clouds.frameLoaded).toBe(true);
		expect(clouds.stop).toHaveBeenCalledOnce();
		expect(clouds.running).toBe(false);
	});

	it('rejects when the cloud frames failed to load', async () => {
		await expect(setup({ cloudFailures: 1 }).handle.ready()).rejects.toThrow('cloud frames failed');
	});

	it('rejects when the feed failed', async () => {
		await expect(setup({ failures: 1 }).handle.ready()).rejects.toThrow('live feed failed');
	});

	it('rejects when the range is not covered', async () => {
		const covered = (time: number) => time < params.start + 30_000;
		await expect(setup({ covered }).handle.ready()).rejects.toThrow('no observations loaded for 2026-07-15T18:30:45');
	});

	it('rejects when textures never load', async () => {
		await expect(setup({ loaded: () => false }).handle.ready()).rejects.toThrow('textures not loaded');
	});
});
