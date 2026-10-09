import { type PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IdleRotation } from './idle';
import { rescaleDistance, rotateSpeedFor, type ZoomLimits, zoomLimits } from './orbit';
import { latLonToVector } from './sun';

/** Placeholder until live activity can pick the view: the Atlantic, seen by both GOES and MTG. */
export const DEFAULT_VIEW = { lat: 15, lon: -40 };

const AUTO_ROTATE_SPEED = 0.4;
const DAMPING = 0.08;

export interface GlobeControls {
	/** Call after the camera aspect changed. */
	resize(): void;
	/** Call once per frame with the animation loop timestamp (ms). */
	update(time: number): void;
	centerOn(lat: number, lon: number): void;
	dispose(): void;
}

interface Options {
	now?: () => number;
}

export function createGlobeControls(
	camera: PerspectiveCamera,
	element: HTMLElement,
	radius: number,
	{ now = () => performance.now() }: Options = {},
): GlobeControls {
	const controls = new OrbitControls(camera, element);
	controls.enableDamping = true;
	controls.dampingFactor = DAMPING;
	controls.enablePan = false;
	controls.autoRotateSpeed = AUTO_ROTATE_SPEED;

	const idle = new IdleRotation();
	const onStart = () => idle.start(now());
	const onEnd = () => idle.end(now());
	controls.addEventListener('start', onStart);
	controls.addEventListener('end', onEnd);

	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

	let limits: ZoomLimits | undefined;
	let previousTime: number | undefined;
	const direction = latLonToVector(DEFAULT_VIEW.lat, DEFAULT_VIEW.lon);
	camera.position.set(...direction);

	const placeCamera = (unit: Vector3, distance: number) => {
		camera.position.copy(unit).multiplyScalar(distance);
		controls.update();
	};

	return {
		resize() {
			const next = zoomLimits(radius, camera.fov, camera.aspect, camera.near, camera.far);
			const distance = limits ? rescaleDistance(camera.position.length(), limits, next) : next.fit;
			limits = next;
			controls.minDistance = next.min;
			controls.maxDistance = next.max;
			placeCamera(camera.position.clone().normalize(), distance);
		},

		update(time) {
			const delta = previousTime === undefined ? 0 : Math.min((time - previousTime) / 1000, 0.1);
			previousTime = time;
			controls.autoRotate = !reducedMotion.matches && idle.rotating(now());
			if (limits) controls.rotateSpeed = rotateSpeedFor(camera.position.length(), radius, limits.fit);
			controls.update(delta);
		},

		centerOn(lat, lon) {
			placeCamera(new Vector3(...latLonToVector(lat, lon)), camera.position.length());
		},

		dispose() {
			controls.removeEventListener('start', onStart);
			controls.removeEventListener('end', onEnd);
			controls.dispose();
		},
	};
}
