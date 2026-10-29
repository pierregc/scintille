import type { Vec3 } from '../sun';
import { glslFloat as f } from './profile';
import { SKELETON } from './skeleton';

/** How the cloud layer hides or veils a channel, from its opacity where the line of sight leaves it; see docs/flash-profile.md. */
export const VEIL = {
	/** Opacity assumed in the cloud while the cloud layer is hidden or has no frame: a flash is always in a cloud. */
	fallback: 0.6,
	/** Width a channel in an opaque cloud spreads to just under its top and at its base, km. */
	topKm: 0.5,
	baseKm: 4,
	/** Light such a channel keeps, spread over its width. */
	level: 0.5,
	/** Below the cloud, `(1 - opacity)^(depth / slant)` of a channel's light comes through. */
	depth: 2,
	/** Share of the slant counted, as the limb thickening of the cloud layer. */
	limb: 0.6,
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where the line of sight from `point` up to `eye` leaves the cloud shell of radius `shell` around the
 * Earth's centre (the origin): `point` itself when it is above the shell or the eye below it.
 */
export function cloudCrossing(point: Vec3, eye: Vec3, shell: number): Vec3 {
	const d: Vec3 = [eye[0] - point[0], eye[1] - point[1], eye[2] - point[2]];
	const reach = Math.hypot(...d);
	const c = dot(point, point) - shell * shell;
	if (c >= 0 || reach === 0) return point;
	const b = dot(point, d) / reach;
	const t = -b + Math.sqrt(b * b - c);
	return t < reach ? [point[0] + (d[0] * t) / reach, point[1] + (d[1] * t) / reach, point[2] + (d[2] * t) / reach] : point;
}

/** Share of a channel's light seen through a cloud of `opacity` above it, the line of sight `slant` (cosine) to the vertical. */
export function cloudTransmission(opacity: number, slant: number): number {
	return (1 - clamp01(opacity)) ** (VEIL.depth / mix(1, Math.max(slant, 0.05), VEIL.limb));
}

/** Width (CSS px) and light share of a channel `heightKm` up inside a cloud of `opacity`, seen at `kmPerPx`. */
export function cloudVeil(opacity: number, heightKm: number, kmPerPx: number, width: number): { width: number; light: number } {
	const depth = clamp01((SKELETON.cloudTopKm - heightKm) / (SKELETON.cloudTopKm - SKELETON.cloudBaseKm));
	const veiled = Math.max(width, (mix(VEIL.topKm, VEIL.baseKm, depth) * opacity) / kmPerPx);
	return { width: veiled, light: (mix(1, VEIL.level, opacity) * width) / veiled };
}

/** GLSL twins of `cloudCrossing`, `cloudTransmission` and `cloudVeil`, with the shell radius as a uniform. */
export const veilGlsl = /* glsl */ `
uniform float cloudShell;
vec3 cloudCrossing(vec3 point, vec3 eye) {
	vec3 d = eye - point;
	float reach = length(d);
	float c = dot(point, point) - cloudShell * cloudShell;
	if (c >= 0.0 || reach == 0.0) return point;
	d /= reach;
	float b = dot(point, d);
	float t = -b + sqrt(b * b - c);
	return t < reach ? point + d * t : point;
}
float cloudTransmission(float opacity, float slant) {
	return pow(1.0 - clamp(opacity, 0.0, 1.0), ${f(VEIL.depth)} / mix(1.0, max(slant, 0.05), ${f(VEIL.limb)}));
}
vec2 cloudVeil(float opacity, float heightKm, float kmPerPx, float width) {
	float depth = clamp((${f(SKELETON.cloudTopKm)} - heightKm) / ${f(SKELETON.cloudTopKm - SKELETON.cloudBaseKm)}, 0.0, 1.0);
	float veiled = max(width, mix(${f(VEIL.topKm)}, ${f(VEIL.baseKm)}, depth) * opacity / kmPerPx);
	return vec2(veiled, mix(1.0, ${f(VEIL.level)}, opacity) * width / veiled);
}
`;
