import type { Vec3 } from '../sun';

export const EARTH_RADIUS_KM = 6371;
/** Distance at which a flash sounds at half its near volume. */
export const REFERENCE_KM = 2500;
/** Screen edges sound this far to the side and up: wider than the field of view, for immersion. */
export const MAX_AZIMUTH = (80 * Math.PI) / 180;
export const MAX_ELEVATION = (45 * Math.PI) / 180;
const MIN_CUTOFF_HZ = 2500;
const CUTOFF_RANGE_HZ = 6000;

export interface Voicing {
	/** Linear gain in [0, 1]. */
	gain: number;
	/** Low-pass cutoff in Hz: distant crackles are softer. */
	cutoff: number;
	/** Unit vector to the flash around the listener: x right, y up, -z ahead. */
	position: Vec3;
}

/** Whether a point at `direction` on a sphere of `radius` faces a camera at `camera`. */
export function facesCamera(direction: Vec3, camera: Vec3, radius: number): boolean {
	return direction[0] * camera[0] + direction[1] * camera[1] + direction[2] * camera[2] > radius;
}

/** Camera-to-flash distance in km, for a flash on the globe surface. */
export function distanceKm(direction: Vec3, camera: Vec3, radius: number): number {
	const dx = camera[0] - direction[0] * radius;
	const dy = camera[1] - direction[1] * radius;
	const dz = camera[2] - direction[2] * radius;
	return (Math.sqrt(dx * dx + dy * dy + dz * dz) / radius) * EARTH_RADIUS_KM;
}

const clamp = (v: number) => Math.min(1, Math.max(-1, v));

/** How a flash of `intensity` (0-1), `km` away, at screen position (`ndcX`, `ndcY`) in [-1, 1] sounds. */
export function voicing(intensity: number, km: number, ndcX: number, ndcY: number): Voicing {
	const near = REFERENCE_KM / (REFERENCE_KM + Math.max(0, km));
	const level = 0.15 + 0.85 * Math.min(1, Math.max(0, intensity)) ** 1.5;
	const azimuth = clamp(ndcX) * MAX_AZIMUTH;
	const elevation = clamp(ndcY) * MAX_ELEVATION;
	const flat = Math.cos(elevation);
	return {
		gain: level * near,
		cutoff: MIN_CUTOFF_HZ + CUTOFF_RANGE_HZ * near,
		position: [Math.sin(azimuth) * flat, Math.sin(elevation), -Math.cos(azimuth) * flat],
	};
}
