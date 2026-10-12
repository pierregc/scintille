import { describe, expect, it } from 'vitest';
import { INTENSITY, intensityBrightness, intensityGlsl, intensityScale } from './intensity';

const steps = Array.from({ length: 11 }, (_, i) => i / 10);

describe('intensityBrightness', () => {
	it('spans the floor to full brightness', () => {
		expect(intensityBrightness(0)).toBe(INTENSITY.floor);
		expect(intensityBrightness(1)).toBe(1);
	});

	it('rises monotonically', () => {
		const b = steps.map(intensityBrightness);
		expect(b.every((x, i) => i === 0 || x > b[i - 1])).toBe(true);
	});

	it('looks evenly spaced once encoded to sRGB', () => {
		const encoded = steps.map((i) => (intensityBrightness(i) - INTENSITY.floor) ** (1 / INTENSITY.gamma));
		const gaps = encoded.slice(1).map((x, i) => x - encoded[i]);
		for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 6);
	});

	it('clamps out-of-contract values', () => {
		expect(intensityBrightness(-0.5)).toBe(INTENSITY.floor);
		expect(intensityBrightness(1.5)).toBe(1);
		expect(intensityBrightness(Number.NaN)).toBe(INTENSITY.floor);
	});
});

describe('intensityScale', () => {
	it('grows linearly from the weakest to the strongest flash', () => {
		expect(intensityScale(0)).toBe(INTENSITY.minScale);
		expect(intensityScale(1)).toBe(INTENSITY.maxScale);
		expect(intensityScale(0.5)).toBeCloseTo((INTENSITY.minScale + INTENSITY.maxScale) / 2, 9);
		expect(intensityScale(2)).toBe(INTENSITY.maxScale);
	});
});

describe('intensityGlsl', () => {
	it('uses the same constants as the TypeScript mapping', () => {
		expect(intensityGlsl).toContain(`mix(${INTENSITY.floor}, 1.0, pow(clamp(intensity, 0.0, 1.0), ${INTENSITY.gamma}))`);
		expect(intensityGlsl).toContain(`mix(${INTENSITY.minScale}, ${INTENSITY.maxScale}, clamp(intensity, 0.0, 1.0))`);
	});
});
