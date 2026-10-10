import { type PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { easeInOut, Flight, type FlyToOptions, kmToWorld, poseAt } from './flight';
import { IdleRotation } from './idle';
import { rescaleDistance, rotateSpeedFor, type ZoomLimits, zoomLimits } from './orbit';
import { latLonToVector } from './sun';

/** Placeholder until live activity can pick the view: the Atlantic, seen by both GOES and MTG. */
export const DEFAULT_VIEW = { lat: 15, lon: -40 };

const AUTO_ROTATE_SPEED = 0.4;
const DAMPING = 0.08;
/** Closest a tilted view may orbit its surface point, as a fraction of the radius. */
const SURFACE_MIN_RANGE = 0.002;
const ROLL_RECOVERY_MS = 600;

export interface GlobeControls {
	/** Call after the camera aspect changed. */
	resize(): void;
	/** Call once per frame with the animation loop timestamp (ms). */
	update(time: number): void;
	centerOn(lat: number, lon: number): void;
	/** Flies to a point, altitude kept within the zoom limits; resolves true on arrival, false if interrupted. */
	flyTo(options: FlyToOptions): Promise<boolean>;
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

	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

	const idle = new IdleRotation();
	let flight: { path: Flight; start: number; done: (arrived: boolean) => void } | undefined;
	// Roll left over from a flight, eased out on top of the orbit controls' world-up view.
	let roll: { offset: Quaternion; start: number } | undefined;
	// A tilted view orbits its surface point, closer than the globe zoom limits allow.
	const minRange = (tilted: boolean) => (tilted ? radius * SURFACE_MIN_RANGE : (limits?.min ?? controls.minDistance));
	const applyRoll = () => {
		if (!roll) return;
		const t = reducedMotion.matches ? 1 : (now() - roll.start) / ROLL_RECOVERY_MS;
		if (t >= 1) {
			roll = undefined;
			return;
		}
		camera.quaternion.multiply(new Quaternion().slerp(roll.offset, 1 - easeInOut(t)));
	};
	const endFlight = (arrived: boolean) => {
		if (!flight) return;
		const { done } = flight;
		flight = undefined;
		const pose = camera.quaternion.clone();
		camera.up.set(0, 1, 0);
		controls.enableDamping = true;
		controls.minDistance = minRange(controls.target.lengthSq() > 0);
		controls.update();
		roll = { offset: camera.quaternion.clone().invert().multiply(pose), start: now() };
		applyRoll();
		idle.end(now());
		done(arrived);
	};
	const onStart = () => {
		endFlight(false);
		idle.start(now());
	};
	const onEnd = () => idle.end(now());
	controls.addEventListener('start', onStart);
	controls.addEventListener('end', onEnd);

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
			if (flight) {
				const elapsed = now() - flight.start;
				const pose = flight.path.at(elapsed);
				camera.position.copy(pose.position);
				camera.quaternion.copy(pose.quaternion);
				controls.target.copy(pose.target);
				if (elapsed >= flight.path.duration) endFlight(true);
				previousTime = time;
				return;
			}
			const delta = previousTime === undefined ? 0 : Math.min((time - previousTime) / 1000, 0.1);
			previousTime = time;
			controls.autoRotate = !reducedMotion.matches && idle.rotating(now());
			if (limits) controls.rotateSpeed = rotateSpeedFor(camera.position.length(), radius, limits.fit);
			controls.update(delta);
			applyRoll();
		},

		centerOn(lat, lon) {
			placeCamera(new Vector3(...latLonToVector(lat, lon)), camera.position.length());
		},

		flyTo({ lat, lon, altitude, tilt = 0, duration }) {
			endFlight(false);
			const requested = altitude === undefined ? camera.position.length() - radius : kmToWorld(altitude, radius);
			// Keep the destination inside the orbit limits so arrival does not snap to another distance.
			const tilted = tilt > 0;
			const base = tilted ? 0 : radius;
			const range = Math.min(Math.max(requested + base, minRange(tilted)), limits?.max ?? controls.maxDistance);
			const to = poseAt(lat, lon, range - base, tilt, radius);
			const from = { position: camera.position.clone(), target: controls.target.clone(), quaternion: camera.quaternion.clone() };
			const reduced = reducedMotion.matches;
			idle.start(now());
			controls.enableDamping = false;
			return new Promise((resolve) => {
				flight = { path: new Flight(from, to, radius, reduced ? 0 : duration), start: now(), done: resolve };
			});
		},

		dispose() {
			endFlight(false);
			controls.removeEventListener('start', onStart);
			controls.removeEventListener('end', onEnd);
			controls.dispose();
		},
	};
}
