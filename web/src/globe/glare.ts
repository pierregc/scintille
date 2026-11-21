import type { Vec3 } from './sun';

/** Sine of the sun's elevation over the ground behind the HUD, and camera altitudes in km, over which the glare fades in. */
export const GLARE = { sunSine: [-0.05, 0.2], altitudeKm: [24_000, 6000] } as const;

/** Screen points (NDC) where HUD text sits: corners, top and bottom edges, centre. */
export const HUD_ANCHORS: readonly [number, number][] = [
	[-0.85, 0.85], [0, 0.85], [0.85, 0.85],
	[-0.85, -0.85], [0, -0.85], [0.85, -0.85],
	[0, 0],
];

const smoothstep = (a: number, b: number, x: number): number => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Ground seen along a ray from the eye, or the limb point it passes closest to when it misses the globe. */
export function groundAlong(eye: Vec3, direction: Vec3, radius: number): Vec3 {
	const d = Math.hypot(...direction) || 1;
	const u: Vec3 = [direction[0] / d, direction[1] / d, direction[2] / d];
	const b = dot(eye, u);
	const c = dot(eye, eye) - radius * radius;
	const disc = b * b - c;
	const t = disc >= 0 ? -b - Math.sqrt(disc) : -b;
	return [eye[0] + u[0] * t, eye[1] + u[1] * t, eye[2] + u[2] * t];
}

/** Sunlit ground under the HUD: 0 over space or at night, 1 in daylight close to the ground. */
export function glare(camera: Vec3, sun: Vec3, altitudeKm: number, ground: readonly Vec3[] = [camera]): number {
	let lit = 0;
	for (const p of ground) lit = Math.max(lit, smoothstep(GLARE.sunSine[0], GLARE.sunSine[1], dot(p, sun) / (Math.hypot(...p) || 1)));
	return lit * smoothstep(GLARE.altitudeKm[0], GLARE.altitudeKm[1], altitudeKm);
}
