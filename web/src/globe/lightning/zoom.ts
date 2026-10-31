import { CHANNEL } from './channel';
import { intensityScale } from './intensity';
import { glslFloat as f } from './profile';

/** How flash sizes follow the zoom, from the km per CSS pixel at the flash; see docs/immersive-view.md. */
export const ZOOM = {
	/** Glow compensation is minimal below `nearKmPerPx` and full above `farKmPerPx`. */
	nearKmPerPx: 0.3,
	farKmPerPx: 3,
	/** Glow radius over the observed radius near the floor, weakest to strongest flash. */
	nearGlow: [1, 2],
	/** Glow radius over the observed radius from afar, times `intensityScale`. */
	farGlow: 4,
	/** Smallest glow radius, CSS px, times `intensityScale`: distant flashes stay points. */
	pointPx: 5,
	/** Channel opacity rises while its half length grows over this range, CSS px. */
	revealPx: [6, 18],
	/** Share of the bloom kept near the floor, where glows are resolved and need no halo to be seen. */
	nearBloom: 0.1,
	/** Glow level near the floor, where the lit cloud and the channels carry the flash; `nearGlowAlone` without cloud light. */
	nearGlowLevel: 0.15,
	nearGlowAlone: 0.4,
} as const;

/** Phones draw lightning as a view of `viewHeight` CSS px would, shrunk to their screen, and dim the glows near the floor. */
export const PHONE = { viewHeight: 1080, nearLevel: 0.6 } as const;

/** CSS px of a `heightPx` tall view per px of the sizes above. */
export function viewScale(heightPx: number, phone: boolean): number {
	return phone && heightPx > 0 ? Math.min(1, heightPx / PHONE.viewHeight) : 1;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};

/** 0 near the floor, 1 from afar. */
export function farness(kmPerPx: number): number {
	return smoothstep(0, 1, Math.log(kmPerPx / ZOOM.nearKmPerPx) / Math.log(ZOOM.farKmPerPx / ZOOM.nearKmPerPx));
}

/** Bloom strength for a view of `kmPerPx` from the camera height, out of the full `strength`. */
export function bloomStrength(kmPerPx: number, strength: number): number {
	return strength * (ZOOM.nearBloom + (1 - ZOOM.nearBloom) * farness(kmPerPx));
}

/** Level of the round glow, out of its full brightness. */
export function glowShare(kmPerPx: number, nearLevel: number = ZOOM.nearGlowLevel): number {
	return nearLevel + (1 - nearLevel) * farness(kmPerPx);
}

/** Glow radius in km of a flash of observed radius `radiusKm`; the point floor stays in CSS px whatever the `viewScale`. */
export function glowRadiusKm(radiusKm: number, intensity: number, kmPerPx: number, scale = 1): number {
	const i = clamp01(intensity);
	const near = ZOOM.nearGlow[0] + (ZOOM.nearGlow[1] - ZOOM.nearGlow[0]) * i;
	const far = ZOOM.farGlow * intensityScale(i);
	const t = farness(kmPerPx * scale);
	return Math.max(radiusKm * (near + (far - near) * t), ZOOM.pointPx * kmPerPx * intensityScale(i));
}

/** Channel opacity in [0, 1]: channels keep their physical length and appear as they get readable. */
export function channelReveal(radiusKm: number, kmPerPx: number): number {
	return smoothstep(ZOOM.revealPx[0], ZOOM.revealPx[1], (radiusKm * CHANNEL.lengthScale) / kmPerPx);
}

/** GLSL twins; needs `intensityScale`. */
export const zoomGlsl = /* glsl */ `
float farness(float kmPerPx) {
	return smoothstep(0.0, 1.0, log(kmPerPx / ${f(ZOOM.nearKmPerPx)}) / ${f(Math.log(ZOOM.farKmPerPx / ZOOM.nearKmPerPx))});
}
float glowRadiusKm(float radiusKm, float intensity, float kmPerPx, float scale) {
	float i = clamp(intensity, 0.0, 1.0);
	float near = mix(${f(ZOOM.nearGlow[0])}, ${f(ZOOM.nearGlow[1])}, i);
	float far = ${f(ZOOM.farGlow)} * intensityScale(i);
	return max(radiusKm * mix(near, far, farness(kmPerPx * scale)), ${f(ZOOM.pointPx)} * kmPerPx * intensityScale(i));
}
float glowShare(float kmPerPx, float nearLevel) {
	return mix(nearLevel, 1.0, farness(kmPerPx));
}
float channelReveal(float radiusKm, float kmPerPx) {
	return smoothstep(${f(ZOOM.revealPx[0])}, ${f(ZOOM.revealPx[1])}, radiusKm * ${f(CHANNEL.lengthScale)} / kmPerPx);
}
`;
