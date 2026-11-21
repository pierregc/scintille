import { WIND_RULES } from '../../contract/wind';
import type { WindLook } from './types';

const EARTH_RADIUS_KM = 6371;

/** How a look draws its fibres: a line integral convolution of noise along the wind. */
export interface WindLookParams {
	/** Height of the shell the fibres are drawn on, km. */
	heightKm: number;
	/** Speeds where fibres start and where they are whole, m/s. */
	calm: number;
	full: number;
	/** 0 keeps a continuous veil; higher keeps only the brightest streaks. */
	sparse: number;
	/** Softness of the fibre edges. */
	soft: number;
	/** Peak opacity. */
	gain: number;
	/** Opacity in daylight, as a share of the night one. */
	day: number;
	/** Fibre width, CSS pixels. */
	cellPx: number;
	/** Fibre length factor. */
	reach: number;
	color: string;
	/** How much observed clouds hide the fibres in daylight, 0 to 1. */
	cloudVeil: number;
}

export const WIND_LOOKS: Readonly<Record<WindLook, Readonly<WindLookParams>>> = {
	jet: { heightKm: 22, calm: 28, full: 70, sparse: 0.3, soft: 2, gain: 0.45, day: 0.55, cellPx: 2.6, reach: 1.5, color: '#d9dcff', cloudVeil: 0 },
	surface: { heightKm: 16, calm: 3, full: 16, sparse: 0, soft: 3.2, gain: 0.12, day: 0.9, cellPx: 2.4, reach: 1.3, color: '#dfe8ff', cloudVeil: 1 },
};

export const WIND_FADE = {
	/** Kilometres per pixel under which the fibres are gone and over which they are whole: close up they read as rain. */
	goneKmPerPx: 1.1,
	wholeKmPerPx: 2.6,
	/** Fade in and out of a close storm view, ms. */
	stormMs: 800,
	/** Cloud opacity over which the fibres are fully hidden in daylight, read blurred over this many pixels. */
	cloudOpaque: 0.35,
	cloudBlurPx: 12,
} as const;

/** Metres per second of one wind component byte (ADR 0039): 128 is calm, 1 and 255 are -scale and +scale. */
export function decodeWindByte(byte: number, scaleMs: number): number {
	return ((byte - 128) / 127) * scaleMs;
}

/** Texture coordinates of a point in a wind field: 90° N at v = 1, 0° E at u = 0, texel centres on the 0.5° grid. */
export function windUv(lat: number, lon: number): [u: number, v: number] {
	const step = WIND_RULES.grid_step_degrees;
	const column = (((lon % 360) + 360) % 360) / step;
	const row = (90 - lat) / step;
	return [(column + 0.5) / WIND_RULES.width, 1 - (row + 0.5) / WIND_RULES.height];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/** Share of the fibres left at a camera height, from kilometres per pixel at the globe. */
export function heightFade(kmPerPx: number): number {
	return smoothstep(WIND_FADE.goneKmPerPx, WIND_FADE.wholeKmPerPx, kmPerPx);
}

/** Moves `current` toward `target` at a constant rate that crosses 0 to 1 in `durationMs`. */
export function easeFade(current: number, target: number, dtMs: number, durationMs: number): number {
	const step = durationMs > 0 ? Math.max(0, dtMs) / durationMs : 1;
	return current < target ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** Daylight share at a point, from the cosine of the sun's angle to its vertical. */
export function dayShare(cosSun: number): number {
	return smoothstep(-0.1, 0.25, cosSun);
}

/** Opacity the fibres keep over clouds of `opacity` (0 to 1) in `day` light (twin of the shader's). */
export function cloudVeil(opacity: number, day: number, veil: number): number {
	return 1 - veil * day * smoothstep(0, WIND_FADE.cloudOpaque, opacity);
}

/** Fibre width in km: `cellPx` screen pixels, never under 2.2 bake texels so the bake resolves it. */
export function fibreCellKm(kmPerPx: number, texelKm: number, cellPx: number): number {
	return Math.min(60, Math.max(1.5, kmPerPx * cellPx, texelKm * 2.2));
}

/**
 * Noise octave for a fibre width: `lo` cells per globe radius at the coarser octave, `blend` toward the
 * finer one, and `cell` the fibre width in globe radii.
 */
export function fibreOctave(cellKm: number): { lo: number; blend: number; cell: number } {
	const octave = Math.log2(EARTH_RADIUS_KM / cellKm);
	const lo = 2 ** Math.floor(octave);
	const blend = octave - Math.floor(octave);
	return { lo, blend, cell: 1 / (lo * (1 + blend)) };
}
