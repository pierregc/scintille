import type { Vec3 } from '../sun';

export const EARTH_RADIUS_KM = 6371;
/** Stylized speed of sound: the real one (0.34 km/s) would delay thunder by hours when seen from orbit. */
export const STYLIZED_KM_PER_S = 6000;
export const MAX_DELAY_S = 4;
/** Distance at which a flash sounds at half its near volume. */
export const REFERENCE_KM = 2500;
const MAX_PAN = 0.8;
const MIN_CUTOFF_HZ = 300;
const CUTOFF_RANGE_HZ = 7000;

export interface Voicing {
	/** Linear gain in [0, 1]. */
	gain: number;
	/** Stereo position in [-1, 1]. */
	pan: number;
	/** Seconds between the flash and its thunder. */
	delay: number;
	/** Low-pass cutoff in Hz: distant thunder is a dull rumble. */
	cutoff: number;
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

/** How a flash of `intensity` (0-1), `km` away, at horizontal screen position `ndcX` (-1 left, 1 right) sounds. */
export function voicing(intensity: number, km: number, ndcX: number): Voicing {
	const near = REFERENCE_KM / (REFERENCE_KM + Math.max(0, km));
	const level = 0.3 + 0.7 * Math.min(1, Math.max(0, intensity));
	return {
		gain: level * near,
		pan: Math.min(1, Math.max(-1, ndcX)) * MAX_PAN,
		delay: Math.min(MAX_DELAY_S, Math.max(0, km) / STYLIZED_KM_PER_S),
		cutoff: MIN_CUTOFF_HZ + CUTOFF_RANGE_HZ * near,
	};
}
