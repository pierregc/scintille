import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { SceneClock } from './clock';
import { createGlobeControls } from './controls';
import { createEarth } from './earth';
import { startLiveFeed } from './live';
import { cappedPixelRatio } from './viewport';
import { CONTEXT_ATTRIBUTES } from './webgl';

export interface GlobeApp {
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
	const earth = createEarth(renderer, RADIUS);
	scene.add(earth.mesh);

	const live = startLiveFeed();
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
		earth.setTime(clock.time());
		renderer.render(scene, camera);
	});

	return {
		dispose() {
			renderer.setAnimationLoop(null);
			controls.dispose();
			live.stop();
			window.removeEventListener('resize', resize);
			dprQuery?.removeEventListener('change', onPixelRatioChange);
			earth.dispose();
			renderer.dispose();
		},
	};
}
