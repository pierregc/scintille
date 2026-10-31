import { BufferAttribute, InstancedBufferGeometry } from 'three';
import { glslFloat as f } from './profile';

/** Drawing choices of the ribbons; see docs/flash-profile.md. */
export const RIBBON = {
	/** Narrowest core drawn, device px: thinner ones alias into dashes on the pixel grid and give up light instead. */
	hairlinePx: 1.25,
} as const;

/** Width and light share of a core `width` CSS px wide drawn at `pxPerCss` device px per CSS px. */
export function hairline(width: number, pxPerCss: number): { width: number; light: number } {
	const least = RIBBON.hairlinePx / pxPerCss;
	return width < least ? { width: least, light: width / least } : { width, light: 1 };
}

/** Cross-fade of a core segment `len` widths long at `x` widths from its start: it overlaps half a width at each joint. */
export function crossfade(x: number, len: number): number {
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	return clamp01(x + 0.5) * clamp01(len + 0.5 - x);
}

/** What `crossfade` integrates to along a segment `len` widths long: `len` once it is a width long, more below. */
export function crossfadeArea(len: number): number {
	if (len >= 1) return len;
	return len * len + ((len + 1) * (1 - len * len)) / 2 - (1 - len ** 3) / 3;
}

/** Scale of a segment's cross-fade so that it adds up to the segment's length: chains of any lengths make an even thread. */
export function lengthShare(len: number): number {
	return len > 0 ? len / crossfadeArea(len) : 0;
}

/** What the square root of `crossfade` integrates to: its screen light, the sRGB conversion taken as a square root. */
export function crossfadeScreenArea(len: number): number {
	if (len >= 1) return len + 1 / 3;
	const h = (1 - len) / 2;
	const r = (1 + len) / 2;
	return (4 / 3) * len ** 1.5 + h * Math.sqrt(len) + r * r * Math.asin(h / r);
}

/**
 * Screen light of a core segment `span` widths long over its light: what its overlapping cross-fades added once each
 * was converted to screen values, 1 + 1 / (3 span) from a width on, up to 3π/4 for the shortest. The core keeps it,
 * evenly, so channels stay as bright as when their joints beaded.
 */
export function overlapGain(span: number): number {
	return crossfadeScreenArea(span) / crossfadeArea(span);
}

/** GLSL twins of `hairline`, `crossfadeArea`, `lengthShare` and `overlapGain`. */
export const ribbonGlsl = /* glsl */ `
vec2 hairline(float width, float pxPerCss) {
	float least = ${f(RIBBON.hairlinePx)} / pxPerCss;
	return width < least ? vec2(least, width / least) : vec2(width, 1.0);
}
float crossfadeArea(float len) {
	if (len >= 1.0) return len;
	return len * len + (len + 1.0) * (1.0 - len * len) / 2.0 - (1.0 - len * len * len) / 3.0;
}
float lengthShare(float len) {
	return len > 0.0 ? len / crossfadeArea(len) : 0.0;
}
float overlapGain(float span) {
	if (span >= 1.0) return 1.0 + 1.0 / (3.0 * span);
	float h = 0.5 * (1.0 - span);
	float r = 0.5 * (1.0 + span);
	return (4.0 / 3.0 * span * sqrt(span) + h * sqrt(span) + r * r * asin(h / r)) / crossfadeArea(span);
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
