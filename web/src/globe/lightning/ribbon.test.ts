import { describe, expect, it } from 'vitest';
import { crossfade, crossfadeArea, crossfadeScreenArea, hairline, lengthShare, overlapGain, overlapTone, overlapToneGlsl, RIBBON, ribbonGlsl } from './ribbon';
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

/** Sum along a straight chain of segments with the given lengths, at `x` widths from its start, of each quad's value. */
const chain = (lengths: number[], x: number, value: (fade: number, len: number) => number) => {
	let start = 0;
	let sum = 0;
	for (const len of lengths) {
		const fade = crossfade(x - start, len);
		if (fade > 0) sum += value(fade, len);
		start += len;
	}
	return sum;
};
/** Screen gain of a segment `span` widths long at the linear value `v`, as the fragment shader mixes it. */
const screenGain = (span: number, v: number) => {
	const gain = overlapGain(span);
	return gain.linear + (gain.screen - gain.linear) * overlapTone(v);
};
/** Screen value of a quad as the shaders draw it now, and as they did before: cross-faded in light, converted on its own. */
const drawn = (level: number) => (fade: number, len: number) => srgb(level) * fade * lengthShare(len) * screenGain(len, level);
const before = (level: number) => (fade: number) => srgb(level * fade);
const stats = (values: number[]) => {
	const mean = values.reduce((s, v) => s + v, 0) / values.length;
	return { mean, max: Math.max(...values) / mean, min: Math.min(...values) / mean };
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
		for (const x of [3, 2.8, 3.3, 5.2, 9.2]) expect(chain(lengths, x, (fade, len) => fade * lengthShare(len))).toBeCloseTo(1, 10);
		const encodedHalves = 2 * srgb(0.1 * 0.5);
		expect(encodedHalves / srgb(0.1)).toBeGreaterThan(1.4);
	});

	it('add up to an even thread over chains of short segments of uneven lengths', () => {
		const lengths = Array.from({ length: 80 }, (_, k) => 0.15 + 0.6 * ((k * 0.618) % 1));
		const total = lengths.reduce((s, l) => s + l, 0);
		const along = Array.from({ length: 400 }, (_, k) => 0.3 * total + (0.4 * total * k) / 400);
		const shared = stats(along.map((x) => chain(lengths, x, (fade, len) => fade * lengthShare(len))));
		expect(shared.max).toBeLessThan(1.1);
		expect(shared.min).toBeGreaterThan(0.9);
		expect(shared.mean).toBeCloseTo(1, 1);
		expect(lengthShare(0)).toBe(0);
	});

	it('keep the old light along a chain of short segments, more evenly than before', () => {
		const lengths = Array.from({ length: 80 }, (_, k) => 0.15 + 0.6 * ((k * 0.618) % 1));
		const total = lengths.reduce((s, l) => s + l, 0);
		const along = Array.from({ length: 400 }, (_, k) => 0.3 * total + (0.4 * total * k) / 400);
		for (const level of [0.05, 0.1, 0.3]) {
			const now = stats(along.map((x) => chain(lengths, x, drawn(level))));
			const old = stats(along.map((x) => chain(lengths, x, before(level))));
			expect(now.mean / old.mean).toBeGreaterThan(0.97);
			expect(now.mean / old.mean).toBeLessThan(1.03);
			expect(now.max).toBeLessThan(Math.min(1.25, old.max));
			expect(now.min).toBeGreaterThan(Math.max(0.8, old.min));
		}
	});
});

describe('overlapGain', () => {
	it('runs from 1 + 1 / (3 span) on screen and 1 in light on long segments, more below, continuous at a width', () => {
		expect(overlapGain(3)).toEqual({ screen: 1 + 1 / 9, linear: 1 });
		expect(overlapGain(1).screen).toBeCloseTo(4 / 3, 10);
		expect(overlapGain(1 - 1e-6).screen).toBeCloseTo(4 / 3, 4);
		expect(overlapGain(1 - 1e-6).linear).toBeCloseTo(1, 4);
		for (let span = 0.1; span < 4; span += 0.05) {
			expect(overlapGain(span).screen).toBeLessThan(overlapGain(span - 0.05).screen);
			expect(overlapGain(span).linear).toBeLessThanOrEqual(overlapGain(span - 0.05).linear);
		}
	});

	it('stops growing below the shortest span', () => {
		const least = overlapGain(RIBBON.minSpan);
		expect(overlapGain(0)).toEqual(least);
		expect(overlapGain(RIBBON.minSpan / 4)).toEqual(least);
		expect(least.screen).toBeCloseTo(crossfadeScreenArea(RIBBON.minSpan) / RIBBON.minSpan, 10);
		expect(least.linear).toBeCloseTo(1 / lengthShare(RIBBON.minSpan), 10);
	});
});

describe('overlapTone', () => {
	it('is 0 where the sRGB conversion is linear, close to 1 in mid tones, a little more in bright ones', () => {
		expect(overlapTone(0)).toBeCloseTo(0, 5);
		expect(overlapTone(0.003)).toBeCloseTo(0, 5);
		expect(overlapTone(0.1)).toBeGreaterThan(0.9);
		expect(overlapTone(0.1)).toBeLessThan(1);
		expect(overlapTone(1)).toBeGreaterThan(1.1);
		expect(overlapTone(1)).toBeLessThan(1.2);
		for (const v of [0.004, 0.01, 0.05, 0.2, 1]) {
			const mean = integral((u) => srgb(v * u), 0, 1) / srgb(v);
			expect(overlapTone(v)).toBeCloseTo(3 * (2 * mean - 1), 5);
		}
	});

	it('gives back what overlapping cross-fades added once converted, exactly from a width on, within 5 to 16 % below', () => {
		for (const level of [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.3, 0.6, 1]) {
			for (const span of [0.0625, 0.125, 0.2, 0.3, 0.5, 0.75, 1, 2, 4]) {
				const added = integral((x) => srgb(level * crossfade(x, span)), -0.5, span + 0.5) / span / srgb(level);
				const ratio = screenGain(span, level) / added;
				expect(ratio).toBeGreaterThan(span >= 1 ? 0.999 : 0.99);
				expect(ratio).toBeLessThan(span >= 1 ? 1.001 : level >= 0.05 ? 1.05 : 1.16);
			}
		}
	});
});

describe('ribbon shaders', () => {
	it('draw cores with the GLSL twins', () => {
		expect(ribbonVertex).toContain(ribbonGlsl);
		expect(ribbonVertex).toContain('hairline(width, pixelRatio * viewScale)');
		expect(ribbonGlsl).toContain(`max(span, ${RIBBON.minSpan})`);
		expect(ribbonVertex).toContain('vShare = lengthShare(vLength) * overlapGain(');
		expect(ribbonFragment).toContain('exp(-y2 * 3.0) * (1.0 - y2)');
		expect(ribbonFragment).toContain(overlapToneGlsl);
		expect(ribbonFragment).toContain('mix(vec3(vShare.y), vec3(vShare.x), overlapTone(value))');
	});

	it('split the screen value at the joints, after the colour space conversion', () => {
		const converted = ribbonFragment.indexOf('#include <colorspace_fragment>');
		expect(converted).toBeGreaterThan(0);
		expect(ribbonFragment.indexOf('vec3 value = gl_FragColor.rgb;')).toBeLessThan(converted);
		expect(ribbonFragment.indexOf('gl_FragColor.rgb *= fade * (')).toBeGreaterThan(converted);
	});
});
