import { Quaternion, Vector3 } from 'three';
import { CAMERA_FLOOR_KM, type CameraPose, FLIGHT, kmToWorld, lookRotation, raiseGaze } from './flight';

/** A camera orbiting a point on the ground. */
export interface SurfaceView {
	/** Unit direction from the globe centre to the point. */
	normal: Vector3;
	/** Unit tangent the camera faces, at the point. */
	heading: Vector3;
	/** Distance from the point to the camera, as chosen; the camera slides back where the floor needs more. */
	range: number;
	/** Radians from looking straight down, up to `FLIGHT.maxTiltDeg`. */
	tilt: number;
	/** Radians the gaze is raised above the point, up to `FLIGHT.maxGazeDeg`. */
	gaze: number;
}

export const SURFACE = {
	/** Radians of tilt or turn per pixel dragged. */
	anglePerPixel: 0.005,
	/** Range factor per wheel pixel. */
	zoomPerPixel: 0.002,
};

const MAX_TILT = (FLIGHT.maxTiltDeg * Math.PI) / 180;
const MAX_GAZE = (FLIGHT.maxGazeDeg * Math.PI) / 180;

export function surfacePose({ normal, heading, range, tilt, gaze }: SurfaceView, radius: number): CameraPose {
	const target = normal.clone().multiplyScalar(radius);
	const offset = normal.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(heading, -Math.sin(tilt));
	const position = target.clone().addScaledVector(offset, Math.max(range, floorRange(tilt, radius)));
	const up = heading.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(normal, Math.sin(tilt));
	return { position, target, quaternion: raiseGaze(lookRotation(position, target, up), gaze), gaze };
}

/** Surface view matching a camera that orbits `target` on the ground. */
export function surfaceFromPose({ position, quaternion, target, gaze = 0 }: CameraPose): SurfaceView {
	const normal = target.clone().normalize();
	const toCamera = position.clone().sub(target);
	const range = toCamera.length();
	const offset = toCamera.divideScalar(range);
	const tilt = Math.acos(Math.min(1, Math.max(-1, offset.dot(normal))));
	const horizontal = offset.projectOnPlane(normal).negate();
	if (horizontal.lengthSq() < 1e-10) horizontal.copy(new Vector3(0, 1, 0).applyQuaternion(quaternion).projectOnPlane(normal));
	if (horizontal.lengthSq() < 1e-10) horizontal.copy(anyTangent(normal));
	return { normal, heading: horizontal.normalize(), range, tilt, gaze };
}

/** Shortest range that keeps the camera above the floor at `tilt` radians. */
export function floorRange(tilt: number, radius: number): number {
	const floor = radius + kmToWorld(CAMERA_FLOOR_KM, radius);
	const c = radius * Math.cos(tilt);
	return -c + Math.sqrt(c * c + floor * floor - radius * radius);
}

/**
 * Tilts with a vertical drag and turns with a horizontal one. Up tilts the orbit to `FLIGHT.maxTiltDeg`,
 * then raises the gaze; down lowers the gaze first. The chosen range is kept, so the way back ends
 * where the drag started.
 */
export function tiltSurface(view: SurfaceView, dx: number, dy: number): SurfaceView {
	const angle = -dy * SURFACE.anglePerPixel;
	let { tilt, gaze } = view;
	if (angle > 0) {
		tilt = Math.min(view.tilt + angle, Math.max(view.tilt, MAX_TILT));
		const rest = view.tilt + angle - tilt;
		if (rest > 0) gaze = Math.min(view.gaze + rest, Math.max(view.gaze, MAX_GAZE));
	} else {
		gaze = Math.max(view.gaze + angle, 0);
		const rest = view.gaze + angle - gaze;
		if (rest < 0) tilt = Math.max(view.tilt + rest, 0);
	}
	const heading = view.heading.clone().applyAxisAngle(view.normal, dx * SURFACE.anglePerPixel);
	return { ...view, tilt, gaze, heading };
}

/** Drags the ground under the pointer: `dx`, `dy` in pixels, `viewHeight` in pixels for the vertical field of view. */
export function panSurface(view: SurfaceView, dx: number, dy: number, radius: number, fovDeg: number, viewHeight: number): SurfaceView {
	const range = Math.max(view.range, floorRange(view.tilt, radius));
	const perPixel = (2 * range * Math.tan((fovDeg * Math.PI) / 360)) / viewHeight / radius;
	const right = view.heading.clone().cross(view.normal);
	const rotation = new Quaternion()
		.setFromAxisAngle(view.heading, -dx * perPixel)
		.premultiply(new Quaternion().setFromAxisAngle(right, -dy * perPixel));
	const normal = view.normal.clone().applyQuaternion(rotation).normalize();
	const heading = view.heading.clone().applyQuaternion(rotation).projectOnPlane(normal).normalize();
	return { ...view, normal, heading };
}

/** Zooms by `pixels` of wheel (positive moves away) from where the camera is, stopping at the floor without changing the tilt. */
export function zoomSurface(view: SurfaceView, pixels: number, radius: number): SurfaceView {
	const floor = floorRange(view.tilt, radius);
	const range = Math.max(Math.max(view.range, floor) * Math.exp(pixels * SURFACE.zoomPerPixel), floor);
	// Zooming in while slid back along the floor keeps the range chosen before.
	return { ...view, range: pixels > 0 ? range : Math.min(range, view.range) };
}

/**
 * Ground point the camera looks at, as a unit vector: where the view ray meets the globe, but never
 * further than the point seen at `FLIGHT.maxTiltDeg`, so it neither races to the horizon nor jumps
 * under the camera once the ray passes it. `eye` and the unit `forward` share a frame centred on the globe.
 */
export function lookedAt(eye: Vector3, forward: Vector3, radius: number, out = new Vector3()): Vector3 {
	const distance = eye.length();
	const up = scratchUp.copy(eye).divideScalar(distance);
	const along = scratchAlong.copy(forward).addScaledVector(up, -forward.dot(up));
	const side = along.length();
	if (side < 1e-9) return out.copy(up);
	along.divideScalar(side);
	let angle = MAX_TILT - Math.asin(Math.min(1, (radius * Math.sin(MAX_TILT)) / distance));
	const b = eye.dot(forward);
	const hit = b * b - distance * distance + radius * radius;
	if (hit > 0 && b < 0) {
		const t = -b - Math.sqrt(hit);
		angle = Math.min(Math.atan2(t * side, distance + t * forward.dot(up)), angle);
	}
	return out.copy(up).multiplyScalar(Math.cos(angle)).addScaledVector(along, Math.sin(angle));
}

const scratchUp = new Vector3();
const scratchAlong = new Vector3();

function anyTangent(normal: Vector3): Vector3 {
	const axis = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
	return axis.projectOnPlane(normal);
}
