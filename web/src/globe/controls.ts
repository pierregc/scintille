import { type PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { type CameraPose, type CameraView, easeInOut, Flight, type FlyToOptions, headingOf, kmToWorld, lookRotation, poseAt } from './flight';
import { IdleRotation } from './idle';
import { rescaleDistance, rotateSpeedFor, type ZoomLimits, zoomLimits } from './orbit';
import { latLonToVector } from './sun';
import {
	floorRange,
	panSurface,
	surfaceFromPose,
	surfacePose,
	type SurfaceView,
	tiltSurface,
	zoomSurface,
} from './surface';

/** Placeholder until live activity can pick the view: the Atlantic, seen by both GOES and MTG. */
export const DEFAULT_VIEW = { lat: 15, lon: -40 };

const AUTO_ROTATE_SPEED = 0.4;
const DAMPING = 0.08;
const ROLL_RECOVERY_MS = 600;
const EXIT_DURATION_MS = 900;
/** Pixels two fingers travel before the gesture is read as a tilt or a pinch. */
const TOUCH_SLOP = 10;

export interface GlobeControls {
	/** Call after the camera aspect changed. */
	resize(): void;
	/** Call once per frame with the animation loop timestamp (ms). */
	update(time: number): void;
	centerOn(lat: number, lon: number): void;
	/** Resolves true on arrival, false if interrupted; preserveRange allows close surface restoration. */
	flyTo(options: FlyToOptions, restore?: { preserveRange?: boolean }): Promise<boolean>;
	isAt(options: FlyToOptions): boolean;
	cancelFlight(): void;
	/** Moves the camera to a view at once, without a flight; ignored during one. */
	place(options: FlyToOptions): void;
	/** Whether a flight is under way. */
	flying(): boolean;
	/** Whether the camera orbits a point on the ground rather than the globe centre. */
	onSurface(): boolean;
	/** Calls `listener` when the visitor starts moving the camera; returns the unsubscribe function. */
	onInput(listener: () => void): () => void;
	view(): CameraView;
	dispose(): void;
}

interface Options {
	now?: () => number;
}

type Gesture = 'tilt' | 'pan' | 'pinch' | 'undecided' | 'globe';

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
	const inputListeners = new Set<() => void>();
	const userInput = () => { for (const listener of inputListeners) listener(); };
	let flight: { path: Flight; start: number; done: (arrived: boolean) => void } | undefined;
	// Roll left over from a flight, eased out on top of the orbit controls' world-up view.
	let roll: { offset: Quaternion; start: number } | undefined;
	// Set while the camera orbits a point on the ground instead of the globe centre.
	let surface: SurfaceView | undefined;
	let limits: ZoomLimits | undefined;
	let previousTime: number | undefined;

	const applyRoll = () => {
		if (!roll) return;
		const t = reducedMotion.matches ? 1 : (now() - roll.start) / ROLL_RECOVERY_MS;
		if (t >= 1) {
			roll = undefined;
			return;
		}
		camera.quaternion.multiply(new Quaternion().slerp(roll.offset, 1 - easeInOut(t)));
	};
	const applyPose = ({ position, quaternion, target }: CameraPose) => {
		camera.position.copy(position);
		camera.quaternion.copy(quaternion);
		controls.target.copy(target);
	};
	const setSurface = (view: SurfaceView) => {
		surface = view;
		controls.enabled = false;
		applyPose(surfacePose(view, radius));
	};
	/** Hands the current pose to the orbit controls, easing out the roll their world-up view adds. */
	const toGlobe = () => {
		surface = undefined;
		controls.enabled = true;
		controls.target.set(0, 0, 0);
		const pose = camera.quaternion.clone();
		camera.up.set(0, 1, 0);
		controls.enableDamping = true;
		controls.minDistance = limits?.min ?? controls.minDistance;
		controls.update();
		roll = { offset: camera.quaternion.clone().invert().multiply(pose), start: now() };
		applyRoll();
	};
	const endFlight = (arrived: boolean) => {
		if (!flight) return;
		const { done } = flight;
		flight = undefined;
		if (controls.target.lengthSq() > 0) {
			setSurface(surfaceFromPose(camera.position, camera.quaternion, controls.target.clone().setLength(radius)));
		} else {
			toGlobe();
		}
		idle.end(now());
		done(arrived);
	};
	const startFlight = (to: CameraPose, duration?: number) => {
		endFlight(false);
		const from = { position: camera.position.clone(), target: controls.target.clone(), quaternion: camera.quaternion.clone() };
		idle.start(now());
		controls.enableDamping = false;
		return new Promise<boolean>((resolve) => {
			flight = { path: new Flight(from, to, radius, reducedMotion.matches ? 0 : duration), start: now(), done: resolve };
		});
	};
	/** Eases from the surface view back to the globe, straight above the point. */
	const leaveSurface = (view: SurfaceView) => {
		const distance = Math.min(Math.max(camera.position.length(), limits?.min ?? 0), limits?.max ?? Infinity);
		const position = view.normal.clone().multiplyScalar(distance);
		const target = new Vector3();
		void startFlight({ position, target, quaternion: lookRotation(position, target, view.heading) }, EXIT_DURATION_MS);
	};
	const exitRange = () => (limits ? limits.min - radius : radius);

	const onStart = () => {
		endFlight(false);
		idle.start(now());
	};
	const onEnd = () => idle.end(now());
	controls.addEventListener('start', onStart);
	controls.addEventListener('end', onEnd);

	const pointers = new Map<number, { x: number; y: number }>();
	let gesture: Gesture | undefined;
	let travel = { dy: 0, spread: 0 };
	const spread = () => {
		const [a, b] = [...pointers.values()];
		return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
	};
	const centroid = () => {
		const all = [...pointers.values()];
		return {
			x: all.reduce((sum, p) => sum + p.x, 0) / all.length,
			y: all.reduce((sum, p) => sum + p.y, 0) / all.length,
		};
	};
	const enterSurface = () => {
		if (surface) return;
		endFlight(false);
		const target = camera.position.clone().setLength(radius);
		setSurface(surfaceFromPose(camera.position, camera.quaternion, target));
	};

	const onPointerDown = (event: PointerEvent) => {
		userInput();
		endFlight(false);
		const touch = event.pointerType === 'touch';
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		element.setPointerCapture?.(event.pointerId);
		if (!touch) {
			const tilt = event.button === 2 || (event.button === 0 && event.ctrlKey);
			if (tilt) {
				onStart();
				enterSurface();
				gesture = 'tilt';
			} else if (surface && event.button === 0) {
				onStart();
				gesture = 'pan';
			}
			return;
		}
		if (pointers.size === 2) {
			gesture = 'undecided';
			travel = { dy: 0, spread: spread() };
		} else if (pointers.size === 1 && surface) {
			onStart();
			gesture = 'pan';
		} else {
			gesture = undefined;
		}
	};

	const onPointerMove = (event: PointerEvent) => {
		const previous = pointers.get(event.pointerId);
		if (!previous || !gesture) return;
		const before = centroid();
		const spreadBefore = spread();
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		const after = centroid();
		const dx = after.x - before.x;
		const dy = after.y - before.y;

		if (gesture === 'undecided') {
			travel.dy += dy;
			const pinch = Math.abs(spread() - travel.spread);
			if (Math.abs(travel.dy) > TOUCH_SLOP && pinch < Math.abs(travel.dy) / 2) {
				onStart();
				enterSurface();
				gesture = 'tilt';
			} else if (pinch > TOUCH_SLOP) {
				gesture = surface ? 'pinch' : 'globe';
			}
			return;
		}
		if (!surface || gesture === 'globe') return;
		if (gesture === 'tilt') setSurface(tiltSurface(surface, dx, dy, radius));
		else if (gesture === 'pan') setSurface(panSurface(surface, dx, dy, radius, camera.fov, element.clientHeight || 1));
		else if (gesture === 'pinch') zoom(-(spread() - spreadBefore) * 2);
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!pointers.delete(event.pointerId)) return;
		if (pointers.size > 0) {
			if (gesture === 'pinch' || gesture === 'tilt') gesture = surface ? 'pan' : undefined;
			return;
		}
		const active = gesture && gesture !== 'globe' && gesture !== 'undecided';
		gesture = undefined;
		if (!active) return;
		onEnd();
		// Back at nadir from far enough: hand straight back to the globe view.
		if (surface && surface.tilt === 0 && surface.range >= exitRange()) toGlobe();
	};

	const zoom = (pixels: number) => {
		if (!surface) return;
		const view = zoomSurface(surface, pixels, radius);
		if (pixels > 0 && view.range > exitRange()) leaveSurface(view);
		else setSurface(view);
	};

	const onWheel = (event: WheelEvent) => {
		userInput();
		endFlight(false);
		if (!surface) return;
		event.preventDefault();
		if (flight) return;
		idle.start(now());
		idle.end(now());
		zoom(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
	};
	const onContextMenu = (event: Event) => event.preventDefault();

	element.addEventListener('pointerdown', onPointerDown);
	element.addEventListener('pointermove', onPointerMove);
	element.addEventListener('pointerup', onPointerUp);
	element.addEventListener('pointercancel', onPointerUp);
	element.addEventListener('wheel', onWheel, { passive: false });
	element.addEventListener('contextmenu', onContextMenu);

	const direction = latLonToVector(DEFAULT_VIEW.lat, DEFAULT_VIEW.lon);
	camera.position.set(...direction);

	const placeCamera = (unit: Vector3, distance: number) => {
		camera.position.copy(unit).multiplyScalar(distance);
		controls.update();
	};

	const destination = ({ lat, lon, altitude, tilt = 0, heading = 0 }: FlyToOptions, preserveRange = false) => {
		const requested = altitude === undefined ? camera.position.length() - radius : kmToWorld(altitude, radius);
		const orbitMin = limits?.min ?? controls.minDistance;
		const onSurface = tilt > 0 || (preserveRange && requested + radius < orbitMin);
		const base = onSurface ? 0 : radius;
		const lowest = onSurface ? floorRange((tilt * Math.PI) / 180, radius) : orbitMin;
		const range = Math.min(Math.max(requested + base, lowest), limits?.max ?? controls.maxDistance);
		const pose = poseAt(lat, lon, range - base, onSurface ? tilt : 0, radius, onSurface ? heading : 0);
		if (onSurface && tilt === 0) pose.target.copy(pose.position).setLength(radius);
		return pose;
	};
	const isAtPose = (pose: CameraPose) => camera.position.distanceTo(pose.position) < radius * 1e-6
		&& camera.quaternion.angleTo(pose.quaternion) < 1e-6;

	return {
		cancelFlight: () => endFlight(false),
		place(options) {
			if (flight) return;
			const pose = destination(options);
			if (pose.target.lengthSq() > 0) setSurface(surfaceFromPose(pose.position, pose.quaternion, pose.target));
			else {
				if (surface) toGlobe();
				applyPose(pose);
			}
		},
		flying: () => flight !== undefined,
		onSurface: () => surface !== undefined,
		onInput(listener) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		view() {
			const direction = controls.target.lengthSq() > 0 ? controls.target.clone().normalize() : camera.position.clone().normalize();
			return {
				lat: Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180 / Math.PI,
				lon: -Math.atan2(direction.z, direction.x) * 180 / Math.PI,
				altitude: (surface ? surface.range : camera.position.length() - radius) / radius * 6371,
				tilt: surface ? surface.tilt * 180 / Math.PI : 0,
				heading: surface ? headingOf(surface.normal, surface.heading) : 0,
			};
		},
		resize() {
			const next = zoomLimits(radius, camera.fov, camera.aspect);
			const distance = limits ? rescaleDistance(camera.position.length(), limits, next) : next.fit;
			limits = next;
			controls.minDistance = next.min;
			controls.maxDistance = next.max;
			if (!surface && !flight) placeCamera(camera.position.clone().normalize(), distance);
		},

		update(time) {
			if (flight) {
				const elapsed = now() - flight.start;
				applyPose(flight.path.at(elapsed));
				if (elapsed >= flight.path.duration) endFlight(true);
				previousTime = time;
				return;
			}
			const delta = previousTime === undefined ? 0 : Math.min((time - previousTime) / 1000, 0.1);
			previousTime = time;
			if (surface) return;
			controls.autoRotate = !reducedMotion.matches && idle.rotating(now());
			if (limits) controls.rotateSpeed = rotateSpeedFor(camera.position.length(), radius, limits.fit);
			controls.update(delta);
			applyRoll();
		},

		centerOn(lat, lon) {
			if (surface) toGlobe();
			placeCamera(new Vector3(...latLonToVector(lat, lon)), camera.position.length());
		},

		isAt: (options) => isAtPose(destination(options)),
		flyTo(options, { preserveRange = false } = {}) {
			const pose = destination(options, preserveRange);
			return startFlight(pose, isAtPose(pose) ? 0 : options.duration);
		},

		dispose() {
			endFlight(false);
			inputListeners.clear();
			controls.removeEventListener('start', onStart);
			controls.removeEventListener('end', onEnd);
			element.removeEventListener('pointerdown', onPointerDown);
			element.removeEventListener('pointermove', onPointerMove);
			element.removeEventListener('pointerup', onPointerUp);
			element.removeEventListener('pointercancel', onPointerUp);
			element.removeEventListener('wheel', onWheel);
			element.removeEventListener('contextmenu', onContextMenu);
			controls.dispose();
		},
	};
}
