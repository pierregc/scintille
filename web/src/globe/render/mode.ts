import type { Camera } from 'three';
import type { SceneClock } from '../clock';
import type { CloudFeed } from '../clouds/feed';
import { kmToWorld, poseAt } from '../flight';
import type { LiveFeed } from '../live';
import { frameTime, type RenderParams } from './params';

/** Offline rendering: nothing moves until `frame()` draws one. */
export interface RenderHandle {
	/** Resolves once data and textures are loaded; rejects when they cannot be. */
	ready(): Promise<void>;
	/** Draws frame `index` into the canvas, synchronously. */
	frame(index: number): void;
}

export interface RenderDeps {
	clock: SceneClock;
	camera: Camera;
	radius: number;
	feed: Pick<LiveFeed, 'client' | 'stop'>;
	/** Loaded once in `ready()`, so no frame arrives while frames are drawn. */
	clouds: Pick<CloudFeed, 'start' | 'poll' | 'idle' | 'stop' | 'failures' | 'settled'>;
	/** Whether the textures the frame needs are loaded. */
	loaded: () => boolean;
	draw: () => void;
	timeoutMs?: number;
}

export function createRenderHandle(params: RenderParams, deps: RenderDeps): RenderHandle {
	const { clock, camera, radius, feed, clouds, loaded, draw, timeoutMs = 60_000 } = deps;
	clock.render(params.start, (params.end - params.start) / params.frames);
	const { lat, lon, altitude, tilt } = params.view;
	const pose = poseAt(lat, lon, kmToWorld(altitude, radius), tilt, radius);

	return {
		async ready() {
			clouds.start();
			await Promise.all([feed.client.idle(), clouds.poll()]);
			await clouds.idle();
			feed.stop();
			clouds.stop();
			if (feed.client.failures > 0) throw new Error('live feed failed to load');
			if (!clouds.settled || clouds.failures > 0) throw new Error('cloud frames failed to load');
			for (const index of [0, params.frames - 1]) {
				const time = frameTime(params, index);
				if (!feed.client.covers(time)) throw new Error(`no observations loaded for ${new Date(time).toISOString()}`);
			}
			await until(loaded, timeoutMs);
		},
		frame(index) {
			clock.seek(frameTime(params, index));
			camera.position.copy(pose.position);
			camera.quaternion.copy(pose.quaternion);
			camera.updateMatrixWorld();
			draw();
		},
	};
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error(`textures not loaded after ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
