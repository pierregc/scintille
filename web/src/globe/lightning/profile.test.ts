import { describe, expect, it } from 'vitest';
import { flashProfile, flickerLength, glowDecay, glowLevel, glslFloat, PROFILE, pulseCount } from './profile';

const DISPLAY = 1.5;

function peaks(durationMs: number, seed: number, flicker = true): number {
	const samples = Array.from({ length: 1501 }, (_, i) => flashProfile(i / 1000, DISPLAY, durationMs, seed, flicker));
	return samples.filter((v, i) => i > 0 && i < samples.length - 1 && v > samples[i - 1] && v >= samples[i + 1]).length;
}

describe('flashProfile', () => {
	it('is dark outside the display duration', () => {
		expect(flashProfile(-0.01, DISPLAY, 250, 0.3)).toBe(0);
		expect(flashProfile(DISPLAY + 0.01, DISPLAY, 250, 0.3)).toBe(0);
		expect(flashProfile(DISPLAY, DISPLAY, 250, 0.3)).toBeCloseTo(0, 6);
	});

	it('flickers more for longer flashes', () => {
		expect(pulseCount(flickerLength(50))).toBe(1);
		expect(pulseCount(flickerLength(250))).toBe(2);
		expect(pulseCount(flickerLength(2000))).toBe(PROFILE.maxPulses);
		expect(peaks(50, 0.5)).toBe(1);
		expect(peaks(700, 0.5)).toBe(PROFILE.maxPulses);
	});

	it('peaks near full brightness then leaves a dim afterglow', () => {
		expect(flashProfile(0.004, DISPLAY, 250, 0.5)).toBeGreaterThan(0.85);
		const glow = flashProfile(0.5, DISPLAY, 250, 0.5);
		expect(glow).toBeGreaterThan(0.01);
		expect(glow).toBeLessThan(PROFILE.afterglow);
	});

	it('gives reduced motion a single soft fade', () => {
		expect(peaks(700, 0.5, false)).toBe(1);
		const v = Array.from({ length: 100 }, (_, i) => flashProfile(0.1 + i / 100, DISPLAY, 700, 0.5, false));
		expect(v.every((x, i) => i === 0 || x <= v[i - 1])).toBe(true);
	});

	it('keeps the same blink and lingers in the afterglow over a minutes-long display', () => {
		const display = 15 * 60;
		expect(flashProfile(0.004, display, 250, 0.5)).toBeCloseTo(flashProfile(0.004, DISPLAY, 250, 0.5), 6);
		expect(flashProfile(60, display, 250, 0.5)).toBeCloseTo(glowLevel(display) * glowDecay(60 / display), 6);
		expect(flashProfile(PROFILE.softRise, display, 250, 0.5, false)).toBeGreaterThan(0.75);
		expect(flashProfile(60, display, 250, 0.5, false)).toBeCloseTo(flashProfile(60, display, 250, 0.5), 6);
	});
});

describe('afterglow', () => {
	it('decays exponentially to exactly zero at the end of the window', () => {
		expect(glowDecay(0)).toBeCloseTo(1, 6);
		expect(glowDecay(1)).toBeCloseTo(0, 6);
	});

	it('keeps the total light comparable across long windows', () => {
		const total = (minutes: number) => glowLevel(minutes * 60) * minutes;
		expect(glowLevel(60)).toBe(PROFILE.afterglow);
		expect(glowLevel(1800)).toBeCloseTo(glowLevel(300) / 6, 6);
		expect(total(30) / total(5)).toBeCloseTo(1, 6);
	});
});

describe('glslFloat', () => {
	it('always prints a float literal', () => {
		expect(glslFloat(1)).toBe('1.0');
		expect(glslFloat(0.04)).toBe('0.04');
	});
});
