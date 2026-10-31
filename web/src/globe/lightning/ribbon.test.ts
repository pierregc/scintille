import { describe, expect, it } from 'vitest';
import { coreProfile, crossfadeArea, crossfadeScreenArea, hairline, overlapGain, RIBBON, ribbonGlsl, segmentWeight } from './ribbon';
import { ribbonFragment, ribbonVertex } from './ribbon.glsl';

/** Light of a straight chain of segments `len` widths long, `y` widths off its axis, at `x` along it. */
const chain = (x: number, y: number, len: number): number => {
	let sum = 0;
	for (let k = -40; k <= 40; k++) sum += coreProfile(y) * segmentWeight(x - k * len, y, len);
	return sum;
};

describe('hairline', () => {
	it('widens a core under the floor and dims it in proportion, keeping its light', () => {
		expect(hairline(0.35, 1)).toEqual({ width: 1.25, light: 0.35 / 1.25 });
		expect(hairline(0.35, 2)).toEqual({ width: 0.625, light: 0.35 / 0.625 });
		expect(hairline(1.6, 1)).toEqual({ width: 1.6, light: 1 });
	});

	it('floors the core at a width whose sampled light hardly depends on where it falls on the pixel grid', () => {
		const sampled = (halfWidth: number, offset: number) => {
			let s = 0;
			for (let j = -3; j <= 3; j++) s += coreProfile((j + offset) / halfWidth);
			return s;
		};
		const spread = (halfWidth: number) => {
			const sums = Array.from({ length: 20 }, (_, k) => sampled(halfWidth, k / 20));
			return Math.max(...sums) / Math.min(...sums);
		};
		expect(spread(RIBBON.hairlinePx)).toBeLessThan(1.07);
		expect(spread(0.75)).toBeGreaterThan(2);
	});
});

describe('segmentWeight', () => {
	it('keeps the cross-fades of long segments, which add up to one at every joint', () => {
		for (const len of [1, 1.5, 4]) {
			for (const x of [0, 0.25, 0.5, 1.3, len / 2]) expect(chain(x, 0, len)).toBeCloseTo(1, 6);
		}
		expect(segmentWeight(2, 0, 4)).toBe(1);
		expect(segmentWeight(-0.5, 0, 4)).toBe(0);
	});

	it('integrates the cross-fades of a short segment over its length', () => {
		for (const len of [0.1, 0.3, 0.8]) {
			let area = 0;
			for (let k = 0; k < 4000; k++) {
				const x = -0.5 + ((len + 1) * (k + 0.5)) / 4000;
				area += Math.min(1, Math.max(0, x + 0.5)) * Math.min(1, Math.max(0, len + 0.5 - x));
			}
			expect((area * (len + 1)) / 4000).toBeCloseTo(crossfadeArea(len), 4);
		}
		expect(crossfadeArea(1)).toBe(1);
	});

	it('stamps short segments so a chain of them keeps the profile and the light of one ribbon', () => {
		for (const len of [0.05, 0.2, 0.5, 0.7, 0.9]) {
			for (const y of [0, 0.3, 0.6]) {
				for (const x of [0, len / 3]) expect(chain(x, y, len) / coreProfile(y)).toBeGreaterThan(0.92);
				for (const x of [0, len / 3]) expect(chain(x, y, len) / coreProfile(y)).toBeLessThan(1.08);
			}
		}
	});

	it('gives a segment of no length no light', () => {
		expect(segmentWeight(0, 0, 0)).toBe(0);
		expect(segmentWeight(0.5, 0.2, 0)).toBe(0);
	});
});

/** Cross-fade of a segment `len` widths long, `x` widths from its start: the ramps the segments overlap with. */
const ramp = (x: number, len: number) => Math.min(1, Math.max(0, x + 0.5)) * Math.min(1, Math.max(0, len + 0.5 - x));
/** The sRGB transfer of three.js, linear light to screen value. */
const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const integral = (g: (x: number) => number, a: number, b: number, n = 8000) => {
	let s = 0;
	for (let k = 0; k < n; k++) s += g(a + ((b - a) * (k + 0.5)) / n);
	return (s * (b - a)) / n;
};

describe('overlapGain', () => {
	it('integrates the square root of the cross-fades in closed form', () => {
		for (const len of [0.02, 0.1, 0.3, 0.6, 0.9, 1, 2.5]) {
			expect(crossfadeScreenArea(len)).toBeCloseTo(integral((x) => Math.sqrt(ramp(x, len)), -0.5, len + 0.5), 4);
		}
	});

	it('runs from 1 + 1 / (3 span) on long segments up to 3π/4, continuous at a width', () => {
		expect(overlapGain(3)).toBeCloseTo(1 + 1 / 9, 10);
		expect(overlapGain(1)).toBeCloseTo(4 / 3, 10);
		expect(overlapGain(1 - 1e-6)).toBeCloseTo(4 / 3, 4);
		expect(overlapGain(1e-6)).toBeCloseTo((3 * Math.PI) / 4, 3);
		for (let span = 0.05; span < 4; span += 0.05) expect(overlapGain(span)).toBeLessThan(overlapGain(span - 0.05));
	});

	it('is what a cross-fade adds once converted to screen values over the light it shares, within 10 % for mid tones', () => {
		for (const level of [0.05, 0.1, 0.3]) {
			for (const span of [0.3, 0.6, 1, 2, 4]) {
				const added = integral((x) => srgb(level * ramp(x, span)), -0.5, span + 0.5) / crossfadeArea(span);
				expect(overlapGain(span) / (added / srgb(level))).toBeGreaterThan(0.9);
				expect(overlapGain(span) / (added / srgb(level))).toBeLessThan(1.1);
			}
		}
	});
});

describe('ribbon shaders', () => {
	it('draw cores with the GLSL twins', () => {
		expect(ribbonVertex).toContain(ribbonGlsl);
		expect(ribbonVertex).toContain('hairline(width, pixelRatio * viewScale)');
		expect(ribbonFragment).toContain(ribbonGlsl);
		expect(ribbonFragment).toContain('segmentWeight(vLocal.x, vLocal.y, vLength)');
		expect(ribbonFragment).toContain('exp(-y2 * 3.0) * (1.0 - y2)');
		expect(ribbonVertex).toContain('vGain = overlapGain(');
		expect(ribbonFragment).toContain('share *= vGain');
	});

	it('split the screen value at the joints, after the colour space conversion', () => {
		const converted = ribbonFragment.indexOf('#include <colorspace_fragment>');
		expect(converted).toBeGreaterThan(0);
		expect(ribbonFragment.indexOf('gl_FragColor.rgb *= share;')).toBeGreaterThan(converted);
	});
});
