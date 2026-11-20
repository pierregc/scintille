import type { Vec3 } from './sun';

/** Sine of the sun's elevation below the camera, and camera altitudes in km, over which the glare fades in. */
export const GLARE = { sunSine: [-0.05, 0.2], altitudeKm: [12_000, 4000] } as const;

const smoothstep = (a: number, b: number, x: number): number => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** Sunlit ground under the HUD: 0 over space or at night, 1 in daylight close to the ground. */
export function glare(camera: Vec3, sun: Vec3, altitudeKm: number): number {
	const length = Math.hypot(...camera) || 1;
	const sine = (camera[0] * sun[0] + camera[1] * sun[1] + camera[2] * sun[2]) / length;
	return smoothstep(GLARE.sunSine[0], GLARE.sunSine[1], sine) * smoothstep(GLARE.altitudeKm[0], GLARE.altitudeKm[1], altitudeKm);
}
