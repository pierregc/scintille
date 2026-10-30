import { describe, expect, it } from 'vitest';
import { halton, marchPhase, volumeFade, VOLUME_FADE_KM, WINDOW_TEXEL_KM, windowAround } from './volume';

const DEG = Math.PI / 180;
const KM_PER_DEGREE = (6371 * Math.PI) / 180;

describe('windowAround', () => {
	it('covers texels of its own size around the point', () => {
		for (let k = 0; k < WINDOW_TEXEL_KM.length; k++) {
			const w = windowAround(38.57, 2.62, k, 512);
			expect((2 * w.halfLat) / DEG * KM_PER_DEGREE / 512).toBeCloseTo(WINDOW_TEXEL_KM[k], 6);
			expect(Math.abs(w.lat / DEG - 38.57)).toBeLessThan(WINDOW_TEXEL_KM[k] / KM_PER_DEGREE);
			expect(w.halfLon).toBeGreaterThan(w.halfLat);
		}
	});

	it('snaps to its texel grid, so small moves keep the same texels', () => {
		const a = windowAround(10, 20, 0, 512);
		const b = windowAround(10 + 0.1 / KM_PER_DEGREE, 20 + 0.1 / KM_PER_DEGREE, 0, 512);
		expect(b.lat).toBe(a.lat);
		expect(b.lon).toBe(a.lon);
	});

	it('nests the windows', () => {
		const spans = WINDOW_TEXEL_KM.map((_, k) => windowAround(-14.56, -44.26, k, 512).halfLat);
		for (let k = 1; k < spans.length; k++) expect(spans[k]).toBeCloseTo(2 * spans[k - 1], 9);
	});
});

describe('marchPhase', () => {
	it('visits every pixel of a 2 by 2 block in four frames', () => {
		const seen = new Set([0, 1, 2, 3].map((n) => marchPhase(n).join()));
		expect(seen.size).toBe(4);
		expect(marchPhase(4)).toEqual(marchPhase(0));
	});
});

describe('volumeFade', () => {
	it('shows the volume near the ground and the flat layer from afar', () => {
		expect(volumeFade(400)).toBe(1);
		expect(volumeFade(VOLUME_FADE_KM[0])).toBe(1);
		expect(volumeFade(VOLUME_FADE_KM[1])).toBe(0);
		expect(volumeFade(20000)).toBe(0);
		const mid = volumeFade((VOLUME_FADE_KM[0] + VOLUME_FADE_KM[1]) / 2);
		expect(mid).toBeCloseTo(0.5, 6);
	});
});

describe('halton', () => {
	it('spreads offsets evenly over 0 to 1', () => {
		expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
		expect([1, 2, 3].map((i) => halton(i, 3))).toEqual([1 / 3, 2 / 3, 1 / 9]);
		const sixteen = Array.from({ length: 16 }, (_, i) => halton(i + 1, 2));
		for (let bin = 0; bin < 4; bin++) expect(sixteen.filter((v) => v >= bin / 4 && v < (bin + 1) / 4)).toHaveLength(4);
	});
});
