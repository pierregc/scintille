import { glslFloat as f } from './profile';

/**
 * How flashes light the clouds from inside: the light map's splat, then how the flat layer and
 * the volume read it. Tuning ranges in brackets.
 */
export const CLOUD_LIGHT = {
	/** Flash profile (its pulses, 0 to 1, whatever its energy) from which it lights its whole footprint [0.3 to 0.5, 0.6 to 0.8]. */
	fullFrom: 0.35,
	fullTo: 0.7,
	/** Splat radius between bright pulses over the full one: a patch crawling along the channel [0.5 to 0.8]. */
	dimSplat: 0.65,
	/** Cloud brightness from the light map, `1 - exp(-gain × light)` [4 to 6]. */
	gain: 5,
	/** Share kept over sunlit cloud, a styled trace like the channel's (physics: none) [0.25 to 0.5]. */
	dayLevel: 0.35,
	/** Contrast of the light map read, `pow(light, sharpen)` [1 to 1.5]. */
	sharpen: 1.25,
	/** The volume's glow over the flat layer's [1.5 to 2.5]. */
	volumeBoost: 1.8,
	/** Where a column rises above the flash, its lit band is centred this far under its top, km [2 to 4]. */
	belowTopKm: 3,
	/** Half width of the lit band, km [3 to 4]. */
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

/** GLSL twin of `flashBand`. */
export const cloudLightGlsl = /* glsl */ `
float flashBand(float h, float top) {
	float d = (h - max(top - ${f(CLOUD_LIGHT.belowTopKm)}, ${f(CLOUD_LIGHT.fallbackHeightKm)})) / ${f(CLOUD_LIGHT.widthKm)};
	return exp(-d * d);
}
`;
