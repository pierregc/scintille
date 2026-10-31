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
