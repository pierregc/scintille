import { describe, expect, it } from 'vitest';
import { CLAP_SECONDS, PEAK, random, softClipCurve, thunderClap } from './synth';

describe('thunderClap', () => {
	const rate = 8000;
	const clap = thunderClap(rate, 1);

	it('has the expected length and peak, with silent edges', () => {
		expect(clap.length).toBe(Math.round(rate * CLAP_SECONDS));
		const peak = clap.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
		expect(peak).toBeCloseTo(PEAK, 5);
		expect(Math.abs(clap[0])).toBe(0);
		expect(Math.abs(clap[clap.length - 1])).toBe(0);
	});

	it('is reproducible per seed and differs between seeds', () => {
		expect(thunderClap(rate, 1)).toEqual(clap);
		expect(thunderClap(rate, 2)).not.toEqual(clap);
	});

	it('decays: the tail is quieter than the start', () => {
		const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
		expect(rms(clap.subarray(0, rate))).toBeGreaterThan(rms(clap.subarray(3 * rate, 4 * rate)) * 2);
	});
});

describe('random', () => {
	it('stays in [0, 1)', () => {
		const r = random(42);
		for (let i = 0; i < 1000; i++) {
			const x = r();
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThan(1);
		}
	});
});

describe('softClipCurve', () => {
	const curve = softClipCurve(1025, 0.7, 0.98);
	const at = (x: number) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))];

	it('is transparent below the knee and never reaches the ceiling', () => {
		expect(at(0.5)).toBeCloseTo(0.5, 2);
		expect(at(-0.5)).toBeCloseTo(-0.5, 2);
		for (const y of curve) expect(Math.abs(y)).toBeLessThan(0.98);
	});

	it('is monotonic', () => {
		for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
	});
});
