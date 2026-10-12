import { glslFloat as f } from './profile';

/** How a flash's normalized intensity in [0, 1] sets its brightness and size; see docs/methodology.md. */
export const INTENSITY = {
	/** Linear-light brightness of the weakest flash, so it never disappears. */
	floor: 0.08,
	/** 2.2 undoes the sRGB output encoding: equal intensity steps look like equal brightness steps. */
	gamma: 2.2,
	/** Glow radius multiplier of the weakest and the strongest flash. */
	minScale: 0.6,
	maxScale: 1.4,
} as const;

const clamp01 = (x: number): number => (x > 0 ? Math.min(x, 1) : 0);

/** Linear-light brightness multiplier in [floor, 1] for a normalized intensity. */
export function intensityBrightness(intensity: number): number {
	return INTENSITY.floor + (1 - INTENSITY.floor) * clamp01(intensity) ** INTENSITY.gamma;
}

/** Glow radius multiplier in [minScale, maxScale] for a normalized intensity. */
export function intensityScale(intensity: number): number {
	return INTENSITY.minScale + (INTENSITY.maxScale - INTENSITY.minScale) * clamp01(intensity);
}

/** GLSL twins of `intensityBrightness` and `intensityScale`. */
export const intensityGlsl = /* glsl */ `
float intensityBrightness(float intensity) {
	return mix(${f(INTENSITY.floor)}, 1.0, pow(clamp(intensity, 0.0, 1.0), ${f(INTENSITY.gamma)}));
}
float intensityScale(float intensity) {
	return mix(${f(INTENSITY.minScale)}, ${f(INTENSITY.maxScale)}, clamp(intensity, 0.0, 1.0));
}
`;
