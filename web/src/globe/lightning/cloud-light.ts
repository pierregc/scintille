import { channelHash } from './channel';
import { glslFloat as f } from './profile';

/**
 * How flashes light the clouds from inside: the light map's splat, then how the flat layer and
 * the volume read it. Tuning ranges in brackets.
 */
export const CLOUD_LIGHT = {
	/** Flash profile (its pulses, 0 to 1, whatever its energy) from which it lights its whole footprint [0.3 to 0.5, 0.6 to 0.8]. */
	fullFrom: 0.35,
	fullTo: 0.7,
	/** Splat radius between bright pulses over the full one: a smaller patch where the light has drifted [0.5 to 0.8]. */
	dimSplat: 0.65,
	/** Lit patch, styled: long over short axis, drawn per flash [1.2 to 2.5], and the amplitudes of its two- and three-lobed edge [0 to 0.25]. */
	aspectMin: 1.4,
	aspectMax: 2.2,
	lobe2: 0.18,
	lobe3: 0.1,
	/** Cloud brightness from the light map, `1 - exp(-gain × light)` [4 to 6]. */
	gain: 5,
	/** Share kept over sunlit cloud, a styled trace like the channel's (physics: none) [0.25 to 0.5]. */
	dayLevel: 0.35,
	/** Sine of the local sun elevation over which the cloud light falls to `dayLevel`. */
	dayFrom: -0.05,
	dayTo: 0.25,
	/** Contrast of the light map read near the floor, `pow(light, sharpen)`, easing to 1 as the window widens to the globe [1 to 1.5]. */
	sharpen: 1.25,
	/** The volume's glow over the flat layer's [1.5 to 2.5]. */
	volumeBoost: 1.8,
	/** Where a column rises above the flash, its lit band is centred this far under its top, km [2 to 4]. */
	belowTopKm: 3,
	/** Half width (1/e) of the lit band, km [3 to 4]. */
	widthKm: 3.5,
	/** Assumed flash height, km above sea level: the lit band of lower columns and of unknown tops [8 to 9]. */
	fallbackHeightKm: 8.5,
} as const;

/** Height of the lit band's centre, km, in a column whose top is `top` km: towers glow near their crown, lower cloud at the flash height. */
export function bandCentre(top: number): number {
	return Math.max(top - CLOUD_LIGHT.belowTopKm, CLOUD_LIGHT.fallbackHeightKm);
}

/** Weight of the lit band at `h` km in a column whose top is `top` km. */
export function flashBand(h: number, top: number): number {
	const d = (h - bandCentre(top)) / CLOUD_LIGHT.widthKm;
	return Math.exp(-d * d);
}

/**
 * Depths (km) into a crossing of `len` km at extinction `sigma` that split the light it sends back
 * into quarters, at the first and the third: a column taken in one piece glows as if cut in many.
 */
export function glowDepths(sigma: number, len: number): [number, number] {
	const a = 1 - Math.exp(-sigma * len);
	const at = (q: number) => Math.min(-Math.log(1 - q * a) / sigma, len);
	return [at(0.25), at(0.75)];
}

/** Share of the cloud light kept at a local sun elevation of sine `s`: all of it at night, `dayLevel` over sunlit cloud. */
export function cloudLightDay(s: number): number {
	const x = Math.min(Math.max((s - CLOUD_LIGHT.dayFrom) / (CLOUD_LIGHT.dayTo - CLOUD_LIGHT.dayFrom), 0), 1);
	return 1 + (CLOUD_LIGHT.dayLevel - 1) * x * x * (3 - 2 * x);
}

/** Exponent of the light map read for a window of half height `halfLat` (radians): `sharpen` near the floor, 1 over the whole globe. */
export function sharpenExponent(halfLat: number): number {
	return CLOUD_LIGHT.sharpen + (1 - CLOUD_LIGHT.sharpen) * Math.min(Math.max(halfLat / (Math.PI / 2), 0), 1);
}

/** Directions sampled to fit a patch inside its splat radius. */
const PATCH_SAMPLES = 24;

/** Phases and amplitudes of a patch's two- and three-lobed edge; `own` (0 to 1) is how much the footprint, not the splat floor, sets its size. */
function patchLobes(seed: number, own: number): [number, number, number, number] {
	return [channelHash(seed, 8) * 2 * Math.PI, channelHash(seed, 9) * 2 * Math.PI, CLOUD_LIGHT.lobe2 * own, CLOUD_LIGHT.lobe3 * own];
}

/** Edge of a flash's lit patch at angle `theta` from its long axis (after the aspect stretch), over its mean. */
export function patchEdge(theta: number, seed: number, own = 1): number {
	const [phase2, phase3, lobe2, lobe3] = patchLobes(seed, own);
	return 1 + lobe2 * Math.sin(2 * theta + phase2) + lobe3 * Math.sin(3 * theta + phase3);
}

/**
 * Seeded shape of a flash's lit patch: heading (radians from east toward north) along its drift, or
 * for ground flashes along the channel's in-cloud feed (both `channelHash(seed, 1)`); aspect; and the
 * scale that brings its farthest point to the splat radius. Round where the splat floor sets the size (`own` 0).
 */
export function cloudPatch(seed: number, own = 1): { heading: number; aspect: number; fit: number } {
	const heading = channelHash(seed, 1) * 2 * Math.PI;
	const drawn = CLOUD_LIGHT.aspectMin + (CLOUD_LIGHT.aspectMax - CLOUD_LIGHT.aspectMin) * channelHash(seed, 7);
	const aspect = 1 + (drawn - 1) * own;
	let reach = 0;
	for (let k = 0; k < PATCH_SAMPLES; k++) {
		const t = (k * 2 * Math.PI) / PATCH_SAMPLES;
		reach = Math.max(reach, patchEdge(t, seed, own) * Math.hypot(Math.cos(t), Math.sin(t) / aspect));
	}
	return { heading, aspect, fit: 1 / reach };
}

/** GLSL twin of `patchEdge`, from the lobes `patchLobes` returns. */
export const patchEdgeGlsl = /* glsl */ `
float patchEdge(float theta, vec4 lobes) {
	return 1.0 + lobes.z * sin(2.0 * theta + lobes.x) + lobes.w * sin(3.0 * theta + lobes.y);
}
`;

/** GLSL twins of `patchLobes` and `cloudPatch` (heading as cos and sin, aspect, fit); need `channelGlsl` and `patchEdgeGlsl`. */
export const cloudPatchGlsl = /* glsl */ `
vec4 patchLobes(float seed, float own) {
	return vec4(vec2(channelHash(seed, 8.0), channelHash(seed, 9.0)) * 6.28318531, vec2(${f(CLOUD_LIGHT.lobe2)}, ${f(CLOUD_LIGHT.lobe3)}) * own);
}
vec4 cloudPatch(float seed, float own, vec4 lobes) {
	float heading = channelHash(seed, 1.0) * 6.28318531;
	float aspect = mix(1.0, mix(${f(CLOUD_LIGHT.aspectMin)}, ${f(CLOUD_LIGHT.aspectMax)}, channelHash(seed, 7.0)), own);
	float reach = 0.0;
	for (int k = 0; k < ${PATCH_SAMPLES}; k++) {
		float t = float(k) * ${f((2 * Math.PI) / PATCH_SAMPLES)};
		reach = max(reach, patchEdge(t, lobes) * length(vec2(cos(t), sin(t) / aspect)));
	}
	return vec4(cos(heading), sin(heading), aspect, 1.0 / reach);
}
`;

/** GLSL twins of `flashBand`, `glowDepths` and `cloudLightDay`. */
export const cloudLightGlsl = /* glsl */ `
float flashBand(float h, float top) {
	float d = (h - max(top - ${f(CLOUD_LIGHT.belowTopKm)}, ${f(CLOUD_LIGHT.fallbackHeightKm)})) / ${f(CLOUD_LIGHT.widthKm)};
	return exp(-d * d);
}
vec2 glowDepths(float sigma, float len) {
	float a = 1.0 - exp(-sigma * len);
	return min(-log(1.0 - vec2(0.25, 0.75) * a) / sigma, vec2(len));
}
float cloudLightDay(float s) {
	return mix(1.0, ${f(CLOUD_LIGHT.dayLevel)}, smoothstep(${f(CLOUD_LIGHT.dayFrom)}, ${f(CLOUD_LIGHT.dayTo)}, s));
}
`;
