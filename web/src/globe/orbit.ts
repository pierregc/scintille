import { fitDistance } from './viewport';

export interface ZoomLimits {
	min: number;
	max: number;
	fit: number;
}

const MIN_ALTITUDE = 0.2;
const MAX_ZOOM_OUT = 2;
const BASE_ROTATE_SPEED = 0.5;

/** Camera distance bounds around the fitted view, kept clear of the near and far planes. */
export function zoomLimits(radius: number, fovDeg: number, aspect: number, near: number, far: number): ZoomLimits {
	const fit = fitDistance(radius, fovDeg, aspect);
	const min = Math.min(fit, Math.max(radius * (1 + MIN_ALTITUDE), radius + 2 * near));
	const max = Math.max(fit, Math.min(fit * MAX_ZOOM_OUT, far - radius));
	return { min, max, fit };
}

export function clampDistance(distance: number, { min, max }: ZoomLimits): number {
	if (Number.isNaN(distance)) return max;
	return Math.min(max, Math.max(min, distance));
}

/** Keeps the same relative zoom when the fitted distance changes (resize, rotation). */
export function rescaleDistance(distance: number, previous: ZoomLimits, next: ZoomLimits): number {
	return clampDistance((distance / previous.fit) * next.fit, next);
}

/** Slows drag rotation as the camera gets closer to the surface. */
export function rotateSpeedFor(distance: number, radius: number, fit: number): number {
	const ratio = (distance - radius) / (fit - radius);
	return BASE_ROTATE_SPEED * Math.min(1.5, Math.max(0.1, ratio));
}
