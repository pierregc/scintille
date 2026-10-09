import {
	AmbientLight,
	DirectionalLight,
	Mesh,
	MeshLambertMaterial,
	PerspectiveCamera,
	Scene,
	SphereGeometry,
	WebGLRenderer,
} from 'three';
import { createGlobeControls } from './controls';
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

	const geometry = new SphereGeometry(RADIUS, 64, 32);
	const material = new MeshLambertMaterial({ color: 0x2b4a7a });
	const sphere = new Mesh(geometry, material);
	scene.add(sphere);

	const light = new DirectionalLight(0xffffff, 2.5);
	light.position.set(-3, 2, 4);
	scene.add(light, new AmbientLight(0xffffff, 0.15));

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
		renderer.render(scene, camera);
	});

	return {
		dispose() {
			renderer.setAnimationLoop(null);
			controls.dispose();
			window.removeEventListener('resize', resize);
			dprQuery?.removeEventListener('change', onPixelRatioChange);
			geometry.dispose();
			material.dispose();
			renderer.dispose();
		},
	};
}
