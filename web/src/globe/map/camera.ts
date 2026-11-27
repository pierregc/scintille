import { type Quaternion, Vector3 } from 'three';
import { headingOf } from '../flight';

/** Camera of a MapLibre globe: the point at the screen centre and how it is seen. */
export interface MapCamera {
	lng: number;
	lat: number;
	zoom: number;
	/** Degrees from looking straight down at the centre. */
	pitch: number;
	/** Degrees clockwise from north. */
	bearing: number;
	/** Degrees about the line of sight. */
	roll: number;
}

const TILE_PX = 512;
const DEG = 180 / Math.PI;

/**
 * MapLibre camera showing the globe as the scene camera does, or null when the screen centre looks past the globe.
 * `position` and `quaternion` are in the globe's frame; `heightPx` is the view height in CSS pixels.
 */
export function mapCamera(position: Vector3, quaternion: Quaternion, radius: number, fovDeg: number, heightPx: number): MapCamera | null {
	const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
	const b = position.dot(forward);
	const hit = b * b - position.lengthSq() + radius * radius;
	if (hit <= 0 || b >= 0) return null;
	const range = -b - Math.sqrt(hit);
	const normal = position.clone().addScaledVector(forward, range).normalize();
	const lat = Math.asin(Math.max(-1, Math.min(1, normal.y)));
	const down = -forward.dot(normal);
	const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
	const along = forward.clone().addScaledVector(normal, down);
	const tilted = along.lengthSq() > 1e-12;
	const level = tilted ? normal.clone().addScaledVector(forward, down).normalize() : up;
	const cameraPx = heightPx / 2 / Math.tan((fovDeg * Math.PI) / 360);
	return {
		lng: -Math.atan2(normal.z, normal.x) * DEG,
		lat: lat * DEG,
		zoom: Math.log2((2 * Math.PI * Math.cos(lat) * cameraPx) / (range / radius) / TILE_PX),
		pitch: Math.acos(Math.max(-1, Math.min(1, down))) * DEG,
		bearing: headingOf(normal, tilted ? along : up.clone().projectOnPlane(normal)),
		roll: Math.atan2(level.clone().cross(up).dot(forward), level.dot(up)) * DEG,
	};
}
