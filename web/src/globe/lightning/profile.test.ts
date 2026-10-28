import { describe, expect, it } from 'vitest';
import {
	flashLife,
	flashProfile,
	flickerLength,
	glowDecay,
	glowLevel,
	glslFloat,
	MAX_LIFE,
	PROFILE,
	pulseGap,
	pulseStarts,
	pulseTau,
} from './profile';

const seeds = Array.from({ length: 400 }, (_, i) => (i * 0.6180339887) % 1);
const at = (wall: number, durationMs = 300, seed = 0.5, display = 0, sceneAge = wall, flicker = true) =>
	flashProfile(wall, sceneAge, display, durationMs, seed, flicker);

function peaks(durationMs: number, seed: number, flicker = true): number {
	const samples = Array.from({ length: 1501 }, (_, i) => at(i / 1000, durationMs, seed, 0, i / 1000, flicker));
	const peak = (v: number, i: number) => i > 0 && i < samples.length - 1 && v > samples[i - 1] && v >= samples[i + 1];
	return samples.filter((v, i) => peak(v, i) && v > PROFILE.afterglow).length;
}

describe('pulses', () => {
	it('are spaced like return strokes, about 60 ms apart within 10 to 200 ms', () => {
		const gaps = seeds.flatMap((seed) => [1, 2, 3, 4].map((k) => pulseGap(seed, k))).sort((a, b) => a - b);
		expect(gaps[0]).toBeGreaterThanOrEqual(PROFILE.minGap);
		expect(gaps.at(-1)).toBeLessThanOrEqual(PROFILE.maxGap);
		expect(gaps[gaps.length >> 1]).toBeGreaterThan(0.05);
		expect(gaps[gaps.length >> 1]).toBeLessThan(0.07);
	});

	it('fill the observed duration, so longer flashes flicker more', () => {
		const count = (ms: number) => seeds.reduce((n, seed) => n + pulseStarts(flickerLength(ms), seed).length, 0) / seeds.length;
		expect(count(60)).toBeLessThan(2);
		expect(count(300)).toBeGreaterThan(3);
		expect(count(800)).toBeGreaterThan(count(300) + 3);
		for (const seed of seeds) expect(pulseStarts(0.3, seed).at(-1)).toBeLessThanOrEqual(0.3);
		expect(peaks(50, 0.5)).toBeLessThanOrEqual(2);
		expect(peaks(600, 0.5)).toBeGreaterThan(4);
	});

	it('decay within tens of milliseconds', () => {
		const taus = seeds.map((seed) => pulseTau(seed, 1));
		expect(Math.min(...taus)).toBeGreaterThanOrEqual(PROFILE.minTau);
		expect(Math.max(...taus)).toBeLessThanOrEqual(PROFILE.maxTau);
		expect(at(0.15, 50)).toBeLessThan(0.15);
	});

	it('light the first frame and are never missed between two frames', () => {
		for (const seed of seeds.slice(0, 50)) {
			expect(at(PROFILE.shutter, 300, seed)).toBeGreaterThan(0.55);
			for (const [k, start] of pulseStarts(0.3, seed).entries()) {
				const phase = (seed * 7) % PROFILE.shutter;
				const frames = [0, 1, 2].map((n) => at(start + phase + n * PROFILE.shutter, 300, seed));
				expect(Math.max(...frames)).toBeGreaterThan(k === 0 ? 0.3 : 0.1);
			}
		}
	});
});

describe('flashProfile', () => {
	it('flickers in wall clock time whatever the replay speed', () => {
		for (const wall of [0.01, 0.05, 0.2, 0.6]) expect(at(wall, 300, 0.3, 0, wall * 600)).toBe(at(wall, 300, 0.3));
	});

	it('lives about a second without afterglow, longer for long flashes', () => {
		expect(at(-0.01)).toBe(0);
		expect(at(0.9)).toBeGreaterThan(0);
		expect(at(flashLife(flickerLength(300)) + 0.01)).toBe(0);
		expect(flashLife(flickerLength(900))).toBeCloseTo(1.4, 6);
		expect(MAX_LIFE).toBe(PROFILE.maxFlicker + PROFILE.tail);
	});

	it('peaks bright then leaves a dim glow', () => {
		expect(at(PROFILE.shutter)).toBeGreaterThan(0.55);
		const glow = at(0.7);
		expect(glow).toBeGreaterThan(0.005);
		expect(glow).toBeLessThan(PROFILE.afterglow);
	});

	it('keeps an afterglow of minutes in scene time', () => {
		const display = 30 * 60;
		expect(at(10, 300, 0.5, display, 600)).toBeCloseTo(glowLevel(display) * glowDecay(600 / display), 6);
		expect(at(10, 300, 0.5, display, display + 1)).toBe(0);
		expect(at(0.004, 300, 0.5, display)).toBeCloseTo(at(0.004), 6);
	});

	it('gives reduced motion a single soft fade', () => {
		expect(peaks(700, 0.5, false)).toBe(1);
		const v = Array.from({ length: 80 }, (_, i) => at(0.1 + i / 100, 700, 0.5, 0, 0.1 + i / 100, false));
		expect(v.every((x, i) => i === 0 || x <= v[i - 1])).toBe(true);
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
