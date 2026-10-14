import { fitDistance } from './viewport';

export interface ZoomLimits {
	min: number;
	max: number;
	fit: number;
}

const MIN_ALTITUDE = 0.2;
const MAX_ZOOM_OUT = 2;
const BASE_ROTATE_SPEED = 0.5;
/** Near plane as a fraction of the distance to the closest shell. */
const NEAR_FRACTION = 0.5;
/** Floor for the near plane, as a fraction of the radius (about 60 m). */
const MIN_NEAR = 1e-5;
const FAR_MARGIN = 1.01;

/** Camera distance bounds around the fitted view. */
export function zoomLimits(radius: number, fovDeg: number, aspect: number): ZoomLimits {
	const fit = fitDistance(radius, fovDeg, aspect);
	const min = Math.min(fit, radius * (1 + MIN_ALTITUDE));
	const max = Math.max(fit, fit * MAX_ZOOM_OUT);
	return { min, max, fit };
}

export interface ClipPlanes {
	near: number;
	far: number;
}

/**
 * Planes for a camera `distance` from the globe centre: near a fraction of the gap to the closest drawn sphere,
 * far just past the horizon of the outermost one.
 */
export function clipPlanes(distance: number, radius: number, shells: readonly number[]): ClipPlanes {
	const spheres = [radius, ...shells];
	const gap = Math.min(...spheres.map((r) => Math.abs(distance - r)));
	const near = Math.max(NEAR_FRACTION * gap, MIN_NEAR * radius);
	const outer = Math.max(...spheres);
	const tangent = (r: number) => Math.sqrt(Math.max(r * r - radius * radius, 0));
	const far = Math.max((tangent(distance) + tangent(outer)) * FAR_MARGIN, 2 * near);
	return { near, far };
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
