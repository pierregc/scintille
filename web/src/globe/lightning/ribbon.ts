import { BufferAttribute, InstancedBufferGeometry } from 'three';
import { glslFloat as f } from './profile';

/** Drawing choices of the ribbons; see docs/flash-profile.md. */
export const RIBBON = {
	/** Narrowest core drawn, device px: thinner ones alias into dashes on the pixel grid and give up light instead. */
	hairlinePx: 1.25,
	/** Shortest segment, in widths, whose overlap light `overlapGain` keeps: it stops growing below. */
	minSpan: 0.0625,
} as const;

/** Width and light share of a core `width` units wide drawn at `pxPerUnit` device px per width unit (pixel ratio × view scale). */
export function hairline(width: number, pxPerUnit: number): { width: number; light: number } {
	const least = RIBBON.hairlinePx / pxPerUnit;
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

/** Scale of a segment's cross-fade so that it adds up to the segment's length: joints add up to one. */
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
 * Light per unit length that overlapping cross-fades added along a chain of segments `span` widths long
 * (unforeshortened) when each quad was converted on its own: in light (`linear`, the bloom's buffer) and on screen
 * for mid tones (`screen`, the sRGB conversion taken as a square root). Cores keep it so channels stay as bright as
 * when their joints beaded; it stops growing below `RIBBON.minSpan`.
 */
export function overlapGain(span: number): { screen: number; linear: number } {
	const s = Math.max(span, RIBBON.minSpan);
	return { screen: crossfadeScreenArea(s) / s, linear: crossfadeArea(s) / s };
}

/**
 * How far a linear value `v` goes from the `linear` to the `screen` overlap gain: 0 where sRGB is linear, about 1 in
 * mid tones, 1.14 at white. It is 3 (2 m - 1), m the mean converted value along a ramp to `v` over the
 * converted `v`, so segments a width long or more get back exactly what their ramps added.
 */
export function overlapTone(v: number): number {
	const knee = 0.0031308;
	const u = knee / Math.max(v, knee);
	const s = 1.055 * Math.max(v, knee) ** (1 / 2.4) - 0.055;
	const mean = 6.46 * knee * u + ((s + 0.055) * (1 - u ** (17 / 12)) * 12) / 17 - 0.055 * (1 - u);
	return 3 * ((2 * mean) / s - 1);
}

/** GLSL twins of `hairline`, `crossfadeArea`, `lengthShare` and `overlapGain` (screen, linear), for the vertex shader. */
export const ribbonGlsl = /* glsl */ `
vec2 hairline(float width, float pxPerUnit) {
	float least = ${f(RIBBON.hairlinePx)} / pxPerUnit;
	return width < least ? vec2(least, width / least) : vec2(width, 1.0);
}
float crossfadeArea(float len) {
	if (len >= 1.0) return len;
	return len * len + (len + 1.0) * (1.0 - len * len) / 2.0 - (1.0 - len * len * len) / 3.0;
}
float lengthShare(float len) {
	return len > 0.0 ? len / crossfadeArea(len) : 0.0;
}
vec2 overlapGain(float span) {
	float s = max(span, ${f(RIBBON.minSpan)});
	if (s >= 1.0) return vec2(1.0 + 1.0 / (3.0 * s), 1.0);
	float h = 0.5 * (1.0 - s);
	float r = 0.5 * (1.0 + s);
	return vec2(4.0 / 3.0 * s * sqrt(s) + h * sqrt(s) + r * r * asin(h / r), crossfadeArea(s)) / s;
}
`;

/** GLSL twin of `overlapTone`, per colour channel, for the fragment shader. */
export const overlapToneGlsl = /* glsl */ `
vec3 overlapTone(vec3 v) {
	vec3 lit = max(v, vec3(0.0031308));
	vec3 u = 0.0031308 / lit;
	vec3 s = 1.055 * pow(lit, vec3(1.0 / 2.4)) - 0.055;
	vec3 mean = 6.46 * 0.0031308 * u + (s + 0.055) * (1.0 - u * pow(u, vec3(5.0 / 12.0))) * 12.0 / 17.0 - 0.055 * (1.0 - u);
	return 3.0 * (2.0 * mean / s - 1.0);
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
