import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { createAtmosphere } from './atmosphere';
import { SceneClock } from './clock';
import { type Clouds, createClouds } from './clouds';
import { attachDevClouds } from './clouds/dev';
import { createGlobeControls } from './controls';
import { applyDevReplay } from './dev-replay';
import { createEarth } from './earth';
import { createLightning } from './lightning';
import { startLiveFeed } from './live';
import { createStarfield } from './starfield';
import { cappedPixelRatio } from './viewport';
import { CONTEXT_ATTRIBUTES } from './webgl';

export interface GlobeApp {
	readonly clock: SceneClock;
	readonly clouds: Clouds;
	dispose(): void;
}

const RADIUS = 1;
const FOV = 35;

export function createGlobeApp(canvas: HTMLCanvasElement, context: WebGL2RenderingContext): GlobeApp {
	const renderer = new WebGLRenderer({ canvas, context, ...CONTEXT_ATTRIBUTES });
	const scene = new Scene();
	const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
	const controls = createGlobeControls(camera, canvas, RADIUS);

	const clock = new SceneClock();
	if (import.meta.env.DEV) applyDevReplay(clock, location.search);
	const earth = createEarth(renderer, RADIUS);
	scene.add(earth.mesh);
	const atmosphere = createAtmosphere(RADIUS);
	earth.mesh.add(atmosphere.mesh);
	const clouds = createClouds(renderer.capabilities.getMaxAnisotropy(), { radius: RADIUS });
	earth.mesh.add(clouds.mesh);
	const detachDevClouds = import.meta.env.DEV ? attachDevClouds(clouds, window) : undefined;
	const stars = createStarfield();
	scene.add(stars.points);

	const live = startLiveFeed();
	const lightning = createLightning(live.ring, { radius: RADIUS });
	scene.add(lightning.mesh);
	let dprQuery: MediaQueryList | undefined;

	const resize = () => {
		const width = window.innerWidth;
		const height = window.innerHeight;
		renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio));
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		controls.resize();
	};

	const watchPixelRatio = () => {
		dprQuery?.removeEventListener('change', onPixelRatioChange);
		dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		dprQuery.addEventListener('change', onPixelRatioChange);
	};

	function onPixelRatioChange() {
		resize();
		watchPixelRatio();
	}

	resize();
	watchPixelRatio();
	window.addEventListener('resize', resize);

	renderer.setAnimationLoop((time) => {
		controls.update(time);
		const now = clock.time();
		earth.setTime(now);
		atmosphere.setTime(now);
		clouds.setTime(now);
		stars.setTime(now);
		lightning.setTime(now);
		renderer.render(scene, camera);
	});

	return {
		clock,
		clouds,
		dispose() {
			renderer.setAnimationLoop(null);
			controls.dispose();
			live.stop();
			window.removeEventListener('resize', resize);
			dprQuery?.removeEventListener('change', onPixelRatioChange);
			earth.dispose();
			atmosphere.dispose();
			detachDevClouds?.();
			clouds.dispose();
			stars.dispose();
			lightning.dispose();
			renderer.dispose();
		},
	};
}
