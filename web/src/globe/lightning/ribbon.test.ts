import { describe, expect, it } from 'vitest';
import { crossfade, crossfadeArea, crossfadeScreenArea, hairline, lengthShare, overlapGain, RIBBON, ribbonGlsl } from './ribbon';
import { ribbonFragment, ribbonVertex } from './ribbon.glsl';

/** Lateral profile of a core, `y` in half-widths, as the fragment shader draws it. */
const profile = (y: number) => {
	const y2 = Math.min(y * y, 1);
	return Math.exp(-3 * y2) * (1 - y2);
};
/** The sRGB transfer of three.js, linear light to screen value. */
const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const integral = (g: (x: number) => number, a: number, b: number, n = 8000) => {
	let s = 0;
	for (let k = 0; k < n; k++) s += g(a + ((b - a) * (k + 0.5)) / n);
	return (s * (b - a)) / n;
};

/** Screen value along a straight chain of segments with the given lengths, at `x` widths from its start. */
const chain = (lengths: number[], x: number, value: (share: number) => number) => {
	let start = 0;
	let sum = 0;
	for (const len of lengths) {
		sum += value(crossfade(x - start, len) * lengthShare(len));
		start += len;
	}
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
			for (let j = -3; j <= 3; j++) s += profile((j + offset) / halfWidth);
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

describe('cross-fades', () => {
	it('integrate in closed form, plain and as square roots', () => {
		for (const len of [0.02, 0.1, 0.3, 0.6, 0.9, 1, 2.5]) {
			expect(crossfadeArea(len)).toBeCloseTo(integral((x) => crossfade(x, len), -0.5, len + 0.5), 4);
			expect(crossfadeScreenArea(len)).toBeCloseTo(integral((x) => Math.sqrt(crossfade(x, len)), -0.5, len + 0.5), 4);
		}
	});

	it('split the screen value so a joint adds up to one: halves converted on their own made a bead', () => {
		const lengths = [3, 2.2, 4, 1.5, 3];
		for (const x of [3, 2.8, 3.3, 5.2, 9.2]) expect(chain(lengths, x, (share) => share)).toBeCloseTo(1, 10);
		const encodedHalves = 2 * srgb(0.1 * 0.5);
		expect(encodedHalves / srgb(0.1)).toBeGreaterThan(1.4);
	});

	it('add up to an even thread over chains of short segments of uneven lengths', () => {
		const lengths = Array.from({ length: 80 }, (_, k) => 0.15 + 0.6 * ((k * 0.618) % 1));
		const total = lengths.reduce((s, l) => s + l, 0);
		const values = Array.from({ length: 400 }, (_, k) => chain(lengths, 0.3 * total + (0.4 * total * k) / 400, (share) => share));
		const mean = values.reduce((s, v) => s + v, 0) / values.length;
		expect(Math.max(...values) / mean).toBeLessThan(1.2);
		expect(Math.min(...values) / mean).toBeGreaterThan(0.8);
		expect(mean).toBeCloseTo(1, 1);
		expect(lengthShare(0)).toBe(0);
	});
});

describe('overlapGain', () => {
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
				const added = integral((x) => srgb(level * crossfade(x, span)), -0.5, span + 0.5) / crossfadeArea(span);
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
		expect(ribbonVertex).toContain('vShare = vec2(lengthShare(vLength), overlapGain(');
		expect(ribbonFragment).toContain('exp(-y2 * 3.0) * (1.0 - y2)');
		expect(ribbonFragment).toContain('share *= vShare.y');
	});

	it('split the screen value at the joints, after the colour space conversion', () => {
		const converted = ribbonFragment.indexOf('#include <colorspace_fragment>');
		expect(converted).toBeGreaterThan(0);
		expect(ribbonFragment.indexOf('gl_FragColor.rgb *= share;')).toBeGreaterThan(converted);
	});
});
