import { BufferAttribute, InstancedBufferGeometry } from 'three';
import { glslFloat as f } from './profile';

/** Lateral profile of a channel core, `y` in half-widths; the fragment shader's twin. */
export function coreProfile(y: number): number {
	const y2 = Math.min(y * y, 1);
	return Math.exp(-3 * y2) * (1 - y2);
}

const integrate = (g: (t: number) => number, a: number, b: number, n = 4000): number => {
	const h = (b - a) / n;
	let s = g(a) + g(b);
	for (let k = 1; k < n; k++) s += g(a + k * h) * (k % 2 ? 4 : 2);
	return (s * h) / 3;
};

/** Drawing choices of the ribbons; see docs/flash-profile.md. */
export const RIBBON = {
	/** Narrowest core drawn, device px: thinner ones alias into dashes on the pixel grid and give up light instead. */
	hairlinePx: 1.25,
	/** Light of a round stamp over that of a width of ribbon, so a chain of stamps is as bright as the ribbon. */
	stampGain: integrate(coreProfile, -1, 1) / (2 * Math.PI * integrate((r) => coreProfile(r) * r, 0, 1)),
} as const;

/** Width and light share of a core `width` CSS px wide drawn at `pxPerCss` device px per CSS px. */
export function hairline(width: number, pxPerCss: number): { width: number; light: number } {
	const least = RIBBON.hairlinePx / pxPerCss;
	return width < least ? { width: least, light: width / least } : { width, light: 1 };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};

/** What the half-width cross-fades of a segment `len` widths long integrate to along it: `len` once it is a width long. */
export function crossfadeArea(len: number): number {
	if (len >= 1) return len;
	return len * len + ((len + 1) * (1 - len * len)) / 2 - (1 - len ** 3) / 3;
}

/**
 * Light share of a core segment `len` widths long at `x` widths from its start and `y` from its axis, on top of the
 * lateral profile: a ribbon with half-width cross-fades at both ends, or a round stamp when the segment is shorter
 * than its width, so that a chain of segments adds up to one whole width of light at any length.
 */
export function segmentWeight(x: number, y: number, len: number): number {
	const ribbon = (clamp01(x + 0.5) * clamp01(len + 0.5 - x) * len) / crossfadeArea(len);
	if (len >= 1) return ribbon;
	const dx = x - 0.5 * len;
	const y2 = Math.min(y * y, 1);
	const stamp = y2 < 1 ? (RIBBON.stampGain * len * Math.exp(-3 * dx * dx) * Math.max(0, 1 - dx * dx - y2)) / (1 - y2) : 0;
	return stamp + (ribbon - stamp) * smoothstep(0.5, 1, len);
}

/** GLSL twins of `hairline`, `crossfadeArea` and `segmentWeight`. */
export const ribbonGlsl = /* glsl */ `
vec2 hairline(float width, float pxPerCss) {
	float least = ${f(RIBBON.hairlinePx)} / pxPerCss;
	return width < least ? vec2(least, width / least) : vec2(width, 1.0);
}
float crossfadeArea(float len) {
	if (len >= 1.0) return len;
	return len * len + (len + 1.0) * (1.0 - len * len) / 2.0 - (1.0 - len * len * len) / 3.0;
}
float segmentWeight(float x, float y, float len) {
	float ribbon = clamp(x + 0.5, 0.0, 1.0) * clamp(len + 0.5 - x, 0.0, 1.0) * len / crossfadeArea(len);
	if (len >= 1.0) return ribbon;
	float dx = x - 0.5 * len;
	float y2 = min(y * y, 1.0);
	float stamp = y2 < 1.0 ? ${f(RIBBON.stampGain)} * len * exp(-3.0 * dx * dx) * max(0.0, 1.0 - dx * dx - y2) / (1.0 - y2) : 0.0;
	return mix(stamp, ribbon, smoothstep(0.5, 1.0, len));
}
`;

/** One quad per channel segment instance; per vertex: which end (0 or 1) and which side (-1 or 1). */
export function segmentGeometry(): InstancedBufferGeometry {
	const g = new InstancedBufferGeometry();
	g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
	g.setAttribute('corner', new BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2));
	g.setIndex([0, 2, 1, 1, 2, 3]);
	return g;
}
