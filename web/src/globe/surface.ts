import { Quaternion, Vector3 } from 'three';
import { CAMERA_FLOOR_KM, type CameraPose, FLIGHT, kmToWorld, lookRotation } from './flight';

/** A camera orbiting a point on the ground. */
export interface SurfaceView {
	/** Unit direction from the globe centre to the point. */
	normal: Vector3;
	/** Unit tangent the camera faces, at the point. */
	heading: Vector3;
	/** Distance from the point to the camera. */
	range: number;
	/** Radians from looking straight down. */
	tilt: number;
}

export const SURFACE = {
	/** Radians of tilt or turn per pixel dragged. */
	anglePerPixel: 0.005,
	/** Range factor per wheel pixel. */
	zoomPerPixel: 0.002,
};

export function surfacePose({ normal, heading, range, tilt }: SurfaceView, radius: number): CameraPose {
	const target = normal.clone().multiplyScalar(radius);
	const offset = normal.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(heading, -Math.sin(tilt));
	const position = target.clone().addScaledVector(offset, range);
	const up = heading.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(normal, Math.sin(tilt));
	return { position, target, quaternion: lookRotation(position, target, up) };
}

/** Surface view matching a camera that looks at `target` on the ground. */
export function surfaceFromPose(position: Vector3, quaternion: Quaternion, target: Vector3): SurfaceView {
	const normal = target.clone().normalize();
	const toCamera = position.clone().sub(target);
	const range = toCamera.length();
	const offset = toCamera.divideScalar(range);
	const tilt = Math.acos(Math.min(1, Math.max(-1, offset.dot(normal))));
	const horizontal = offset.projectOnPlane(normal).negate();
	if (horizontal.lengthSq() < 1e-10) horizontal.copy(new Vector3(0, 1, 0).applyQuaternion(quaternion).projectOnPlane(normal));
	if (horizontal.lengthSq() < 1e-10) horizontal.copy(anyTangent(normal));
	return { normal, heading: horizontal.normalize(), range, tilt };
}

/** Largest tilt that keeps the camera above the floor. */
export function maxTilt(range: number, radius: number): number {
	const floor = radius + kmToWorld(CAMERA_FLOOR_KM, radius);
	const cos = (floor * floor - radius * radius - range * range) / (2 * radius * range);
	const limit = (FLIGHT.maxTiltDeg * Math.PI) / 180;
	if (cos <= Math.cos(limit)) return limit;
	return cos >= 1 ? 0 : Math.acos(cos);
}

/** Shortest range that keeps the camera above the floor at `tilt` radians. */
export function floorRange(tilt: number, radius: number): number {
	const floor = radius + kmToWorld(CAMERA_FLOOR_KM, radius);
	const c = radius * Math.cos(tilt);
	return -c + Math.sqrt(c * c + floor * floor - radius * radius);
}

/** Tilts with a vertical drag (up looks toward the horizon) and turns with a horizontal one. */
export function tiltSurface(view: SurfaceView, dx: number, dy: number, radius: number): SurfaceView {
	const tilt = Math.min(Math.max(view.tilt - dy * SURFACE.anglePerPixel, 0), maxTilt(view.range, radius));
	const heading = view.heading.clone().applyAxisAngle(view.normal, dx * SURFACE.anglePerPixel);
	return { ...view, tilt, heading };
}

/** Drags the ground under the pointer: `dx`, `dy` in pixels, `viewHeight` in pixels for the vertical field of view. */
export function panSurface(view: SurfaceView, dx: number, dy: number, radius: number, fovDeg: number, viewHeight: number): SurfaceView {
	const perPixel = (2 * view.range * Math.tan((fovDeg * Math.PI) / 360)) / viewHeight / radius;
	const right = view.heading.clone().cross(view.normal);
	const rotation = new Quaternion()
		.setFromAxisAngle(view.heading, -dx * perPixel)
		.premultiply(new Quaternion().setFromAxisAngle(right, -dy * perPixel));
	const normal = view.normal.clone().applyQuaternion(rotation).normalize();
	const heading = view.heading.clone().applyQuaternion(rotation).projectOnPlane(normal).normalize();
	return { ...view, normal, heading };
}

/** Zooms by `pixels` of wheel (positive moves away), stopping at the floor without changing the tilt. */
export function zoomSurface(view: SurfaceView, pixels: number, radius: number): SurfaceView {
	const range = Math.max(view.range * Math.exp(pixels * SURFACE.zoomPerPixel), floorRange(view.tilt, radius));
	return { ...view, range, tilt: Math.min(view.tilt, maxTilt(range, radius)) };
}

function anyTangent(normal: Vector3): Vector3 {
	const axis = Math.abs(normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
	return axis.projectOnPlane(normal);
}
