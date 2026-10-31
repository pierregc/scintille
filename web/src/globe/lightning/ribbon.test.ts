import { describe, expect, it } from 'vitest';
import { coreProfile, crossfadeArea, hairline, RIBBON, ribbonGlsl, segmentWeight } from './ribbon';
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

describe('ribbon shaders', () => {
	it('draw cores with the GLSL twins', () => {
		expect(ribbonVertex).toContain(ribbonGlsl);
		expect(ribbonVertex).toContain('hairline(width, pixelRatio * viewScale)');
		expect(ribbonFragment).toContain(ribbonGlsl);
		expect(ribbonFragment).toContain('segmentWeight(vLocal.x, vLocal.y, vLength)');
		expect(ribbonFragment).toContain('exp(-y2 * 3.0) * (1.0 - y2)');
	});

	it('split the screen value at the joints, after the colour space conversion', () => {
		const converted = ribbonFragment.indexOf('#include <colorspace_fragment>');
		expect(converted).toBeGreaterThan(0);
		expect(ribbonFragment.indexOf('gl_FragColor.rgb *= share;')).toBeGreaterThan(converted);
	});
});
