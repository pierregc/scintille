import { CLOUD_SHELL_KM } from '../clouds/bounds';
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
	/** Least light a channel keeps below any cloud, and a trace in the cloud; a trace spreads at most this many core widths (styled: from orbit a channel shows only in clear air). */
	trace: 0.3,
	traceWidth: 2,
	/** Under a cloud drawn in relief, channels stay this far under its top, km, their part in the cloud compressed at most to this share, or stretched at most this much toward a taller top (styled). */
	reliefMargin: 0.5,
	reliefMin: 0.3,
	reliefStretch: 1.7,
	/** Seen from above, a flash meets this share of the cloud's opacity: clouds slightly transparent over lightning (styled, ADR 0035). */
	through: 0.55,
	/** Over these slant paths (1 / cosine of the view to the vertical, at most maxPath) the cloud crossed toward the eye veils a flash fully, spread that much farther: at a slant it reads inside the cloud. */
	slantPath: [1.5, 4],
	maxPath: 5,
	/** Clouds drawn in relief hide what is in them this many times faster than they hide the ground (styled). */
	hideRate: 3,
	/** Hidden by such clouds a channel keeps this share of its light at their near side, falling by 1/e every `behindKm` further along the line of sight, never under `behindMin`, or under `trace` below the cloud base (styled: clouds stay translucent to their lightning). */
	behind: 0.75,
	behindKm: 20,
	behindMin: 0.12,
	/** Such clouds scatter the light of a main channel they hide around it: a soft tube this wide either side, km, from above and at a slant, between these widths on screen, at these shares of the channel's light seen from above and at a slant, falling by 1/e every `scatterDepthKm`. */
	scatterKm: [4, 9],
	scatterPx: [5, 40],
	scatterLevel: [0.2, 0.9],
	scatterDepthKm: 30,
	/** Channel light from which a path scatters in full; dimmer ones fade out. */
	scatterFrom: 0.25,
	/** Share of its core a channel they hide keeps at a slant, where they carry it as scattered light, over these slant paths (1 / cosine of the view to the vertical). */
	slantCore: 0.2,
	slantCorePath: [1.2, 2.5],
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

/** Share of its light a channel in clear air keeps under a cloud of `opacity`: what comes through, at least the trace. */
export function clearAirLight(opacity: number, slant: number): number {
	return Math.max(cloudTransmission(opacity, slant), VEIL.trace);
}

/**
 * Width (CSS px) and light share of a channel `heightKm` up inside a cloud of `opacity`, seen at `kmPerPx`: spread
 * deeper in the cloud (cloud flag 1), or kept a crisp trace (flag 2).
 */
export function cloudVeil(opacity: number, heightKm: number, kmPerPx: number, width: number, flag: number): { width: number; light: number } {
	const depth = clamp01((SKELETON.cloudTopKm - heightKm) / (SKELETON.cloudTopKm - SKELETON.cloudBaseKm));
	const spread = Math.max(width, (mix(VEIL.topKm, VEIL.baseKm, depth) * opacity) / kmPerPx);
	const veiled = flag > 1.5 ? Math.min(spread, VEIL.traceWidth * width) : spread;
	const light = (mix(1, VEIL.level, opacity) * width) / veiled;
	return { width: veiled, light: flag > 1.5 ? Math.max(light, VEIL.trace) : light };
}

/** How much of a flash's veil comes from the cloud crossed at a slant rather than from above, 0 to 1. */
export function grazingShare(slant: number): number {
	const path = Math.min(VEIL.maxPath, Math.max(1, 1 / Math.max(slant, 0.05)));
	const t = clamp01((path - VEIL.slantPath[0]) / (VEIL.slantPath[1] - VEIL.slantPath[0]));
	return t * t * (3 - 2 * t);
}

/**
 * Opacity an in-cloud channel meets seen at `slant`, and how many times farther the cloud spreads it: slightly
 * transparent from above, thickened by the cloud crossed toward the eye at a slant.
 */
export function seenThrough(opacity: number, slant: number): { opacity: number; reach: number } {
	const path = Math.min(VEIL.maxPath, Math.max(1, 1 / Math.max(slant, 0.05)));
	const grazing = grazingShare(slant);
	const thick = 1 - (1 - Math.min(Math.max(opacity, 0), 0.999)) ** mix(1, path, VEIL.limb);
	return { opacity: thick * mix(VEIL.through, 1, grazing), reach: mix(Math.sqrt(path), path, grazing) };
}

/**
 * Share of its light a segment `lengthPx` long keeps once the cloud spreads it from `width` to `veiled` px: a segment
 * shorter than that width overlaps its neighbours over it, so they share their light and a path does not add up to a
 * saturated tube.
 */
export function veilOverlap(lengthPx: number, width: number, veiled: number): number {
	return Math.min(1, Math.max(lengthPx, width) / veiled);
}

/** Share of its light a channel keeps `km` behind the near side of drawn clouds hiding `hidden` of it, at least `least`. */
export function behindLight(hidden: number, km: number, least: number = VEIL.behindMin): number {
	return mix(1, Math.max(VEIL.behind * Math.exp(-Math.max(km, 0) / VEIL.behindKm), least), clamp01(hidden));
}

/** How much a view at `slant` (cosine to the vertical) counts as one at a slant for the channels the drawn clouds hide, 0 to 1. */
export function slantShare(slant: number): number {
	const t = clamp01((1 / Math.max(slant, 0.05) - VEIL.slantCorePath[0]) / (VEIL.slantCorePath[1] - VEIL.slantCorePath[0]));
	return t * t * (3 - 2 * t);
}

/** Share of its core such a channel keeps at that share of slant. */
export function slantCore(hidden: number, share: number): number {
	return mix(1, VEIL.slantCore, clamp01(hidden) * share);
}

/** Level of the light such clouds scatter around that channel, out of the channel's own. */
export function scatterLight(hidden: number, km: number, share: number): number {
	return mix(VEIL.scatterLevel[0], VEIL.scatterLevel[1], share) * clamp01(hidden) * Math.exp(-Math.max(km, 0) / VEIL.scatterDepthKm);
}

export type Lift = [base: number, share: number, scale: number, ceiling: number];

/** The lift under the flat layer, where no top is known: heights as drawn, kept under the shell. */
export const FLAT_LIFT: Lift = [SKELETON.cloudBaseKm, 1, 1, CLOUD_SHELL_KM - VEIL.reliefMargin];

/**
 * Relief lift under a cloud drawn with its top at `topKm`: the base heights are kept, the share the part in the cloud
 * is compressed or stretched to so it ends under the top, a scale lowering everything when even that would rise over
 * it, and the ceiling nothing passes.
 */
export function reliefLift(topKm: number): Lift {
	const base = SKELETON.cloudBaseKm;
	const ceiling = topKm - VEIL.reliefMargin;
	const share = Math.min(VEIL.reliefStretch, Math.max(VEIL.reliefMin, (ceiling - base) / (SKELETON.cloudTopKm - base)));
	return [base, share, Math.min(1, Math.max(VEIL.reliefMin, ceiling / (base + (SKELETON.cloudTopKm - base) * share))), Math.max(ceiling, 0)];
}

/** Height `z` km drawn under a lift: a drop keeps its height under the base, the part in the cloud follows the top, nothing passes the ceiling. */
export function liftHeight(z: number, lift: Lift): number {
	return Math.min((z <= lift[0] ? z : lift[0] + (z - lift[0]) * lift[1]) * lift[2], lift[3]);
}

/** GLSL twins of `cloudCrossing`, `cloudTransmission`, `clearAirLight`, `grazingShare`, `seenThrough`, `cloudVeil`, `veilOverlap`, `reliefLift` and `liftHeight` (on a point), with the shell radius as a uniform. */
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
float clearAirLight(float opacity, float slant) {
	return max(cloudTransmission(opacity, slant), ${f(VEIL.trace)});
}
float grazingShare(float slant) {
	float path = clamp(1.0 / max(slant, 0.05), 1.0, ${f(VEIL.maxPath)});
	return smoothstep(${f(VEIL.slantPath[0])}, ${f(VEIL.slantPath[1])}, path);
}
vec2 seenThrough(float opacity, float slant) {
	float path = clamp(1.0 / max(slant, 0.05), 1.0, ${f(VEIL.maxPath)});
	float grazing = grazingShare(slant);
	float thick = 1.0 - pow(1.0 - clamp(opacity, 0.0, 0.999), mix(1.0, path, ${f(VEIL.limb)}));
	return vec2(thick * mix(${f(VEIL.through)}, 1.0, grazing), mix(sqrt(path), path, grazing));
}
vec2 cloudVeil(float opacity, float heightKm, float kmPerPx, float width, float flag) {
	float depth = clamp((${f(SKELETON.cloudTopKm)} - heightKm) / ${f(SKELETON.cloudTopKm - SKELETON.cloudBaseKm)}, 0.0, 1.0);
	float spread = max(width, mix(${f(VEIL.topKm)}, ${f(VEIL.baseKm)}, depth) * opacity / kmPerPx);
	float veiled = flag > 1.5 ? min(spread, ${f(VEIL.traceWidth)} * width) : spread;
	float light = mix(1.0, ${f(VEIL.level)}, opacity) * width / veiled;
	return vec2(veiled, flag > 1.5 ? max(light, ${f(VEIL.trace)}) : light);
}
float veilOverlap(float lengthPx, float width, float veiled) {
	return min(1.0, max(lengthPx, width) / veiled);
}
const vec4 flatLift = vec4(${FLAT_LIFT.map(f).join(', ')});
vec4 reliefLift(float topKm) {
	float ceiling = topKm - ${f(VEIL.reliefMargin)};
	float share = clamp((ceiling - ${f(SKELETON.cloudBaseKm)}) / ${f(SKELETON.cloudTopKm - SKELETON.cloudBaseKm)}, ${f(VEIL.reliefMin)}, ${f(VEIL.reliefStretch)});
	return vec4(${f(SKELETON.cloudBaseKm)}, share, clamp(ceiling / (${f(SKELETON.cloudBaseKm)} + ${f(SKELETON.cloudTopKm - SKELETON.cloudBaseKm)} * share), ${f(VEIL.reliefMin)}, 1.0), max(ceiling, 0.0));
}
float behindLight(float hidden, float km, float least) {
	return mix(1.0, max(${f(VEIL.behind)} * exp(-max(km, 0.0) / ${f(VEIL.behindKm)}), least), clamp(hidden, 0.0, 1.0));
}
float slantShare(float slant) {
	return smoothstep(${f(VEIL.slantCorePath[0])}, ${f(VEIL.slantCorePath[1])}, 1.0 / max(slant, 0.05));
}
float slantCore(float hidden, float share) {
	return mix(1.0, ${f(VEIL.slantCore)}, clamp(hidden, 0.0, 1.0) * share);
}
float scatterLight(float hidden, float km, float share) {
	return mix(${f(VEIL.scatterLevel[0])}, ${f(VEIL.scatterLevel[1])}, share) * clamp(hidden, 0.0, 1.0) * exp(-max(km, 0.0) / ${f(VEIL.scatterDepthKm)});
}
vec3 liftPoint(vec3 p, vec4 lift) {
	return vec3(p.xy, min((p.z <= lift.x ? p.z : lift.x + (p.z - lift.x) * lift.y) * lift.z, lift.w));
}
`;
