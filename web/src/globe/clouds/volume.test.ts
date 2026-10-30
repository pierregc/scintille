import { describe, expect, it } from 'vitest';
import {
	bakeTaps,
	halton,
	kmBetween,
	marchPhase,
	NEAR_MAX_KM,
	RELIEF_NEAR_KM,
	RELIEF_TOP_PX_KM,
	reliefFade,
	volumeFade,
	VOLUME_FADE_KM,
	WINDOW_TEXEL_KM,
	windowAround,
	windowToBake,
	within,
} from './volume';

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

describe('within', () => {
	const km = (a: [number, number], b: [number, number]) => {
		const c = Math.sin(a[0] * DEG) * Math.sin(b[0] * DEG) + Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.cos((a[1] - b[1]) * DEG);
		return Math.acos(Math.min(1, c)) * 6371;
	};

	it('keeps a point that is close enough and pulls a far one back along the great circle', () => {
		expect(within([10, 20], [11, 20], 400)).toEqual([11, 20]);
		const pulled = within([10, 20], [10, 40], 400);
		expect(km([10, 20], pulled)).toBeCloseTo(400, 3);
		expect(km(pulled, [10, 40]) + 400).toBeCloseTo(km([10, 20], [10, 40]), 3);
	});

	it('keeps the 2 km window inside the 4 km one wherever the fine centre is pulled to', () => {
		let seed = 7;
		const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		for (let n = 0; n < 2000; n++) {
			const centre: [number, number] = [(random() - 0.5) * 140, (random() - 0.5) * 360];
			const far: [number, number] = [Math.max(-80, Math.min(80, centre[0] + (random() - 0.5) * 30)), centre[1] + (random() - 0.5) * 30];
			const near = within(centre, far, NEAR_MAX_KM);
			const fine = windowAround(near[0], near[1], 1, 512);
			const coarse = windowAround(centre[0], centre[1], 2, 512);
			for (const [u, v] of [[-0.96, -0.96], [0.96, -0.96], [-0.96, 0.96], [0.96, 0.96]]) {
				const lat = fine.lat + v * fine.halfLat;
				const lon = fine.lon + u * fine.halfLon;
				const dLon = ((((lon - coarse.lon + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
				expect(Math.max(Math.abs(dLon / coarse.halfLon), Math.abs((lat - coarse.lat) / coarse.halfLat))).toBeLessThan(0.98);
			}
		}
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

describe('reliefFade', () => {
	it('leaves close views to the volume, shades far ones, and stops before the heights do', () => {
		expect(reliefFade(400, 0.25)).toEqual({ shade: 1, relief: 0 });
		expect(reliefFade(RELIEF_NEAR_KM[1], 0.8)).toEqual({ shade: 1, relief: 1 });
		expect(reliefFade(VOLUME_FADE_KM[1], 1.8)).toEqual({ shade: 1, relief: 1 });
		expect(reliefFade(7700, RELIEF_TOP_PX_KM[1])).toEqual({ shade: 0, relief: 0 });
		expect(reliefFade(18000, 11)).toEqual({ shade: 0, relief: 0 });
		const mid = reliefFade(7000, (RELIEF_TOP_PX_KM[0] + RELIEF_TOP_PX_KM[1]) / 2);
		expect(mid.shade).toBeCloseTo(0.5, 6);
		expect(mid.relief).toBeCloseTo(0.5, 6);
	});

	it('stops before a texel of the global frame (9.8 km) spans two pixels, where heights stop loading', () => {
		expect(RELIEF_TOP_PX_KM[1]).toBeLessThan((((360 / 4096) * Math.PI) / 180) * 6371 / 2);
	});
});

describe('windowToBake', () => {
	const none = () => [false, false, false, false, false];
	it('bakes missing windows first, coarsest first', () => {
		expect(windowToBake([false, false, true, true, true], none, 2, 1, 4, 128)).toBe(4);
		expect(windowToBake([false, false, true, true, false], none, 2, 1, 4, 128)).toBe(3);
	});

	it('takes changed windows in turn, so a window changing every time never starves the others', () => {
		const all = () => [true, true, true, true, true];
		const picked = [0, 4, 8, 12, 16, 20].map((frame) => windowToBake([false, false, false, false, false], all, 2, frame, 4, 128));
		expect(new Set(picked)).toEqual(new Set([2, 3, 4]));
		expect(windowToBake([false, false, false, false, false], all, 2, 5, 4, 128)).toBe(-1);
	});

	it('refreshes one window in turn now and then when nothing changed', () => {
		const missing = [false, false, false, false];
		expect(windowToBake(missing, () => missing, 0, 30, 2, 32)).toBe(-1);
		const refreshed = [0, 32, 64, 96].map((frame) => windowToBake(missing, () => missing, 0, frame, 2, 32));
		expect(refreshed).toEqual([0, 1, 2, 3]);
	});
});

describe('bakeTaps', () => {
	it('averages each coarse texel at about the spacing of the finest heights (2 to 4 km)', () => {
		for (let k = 0; k < WINDOW_TEXEL_KM.length; k++) {
			const [heights, cover] = bakeTaps(k);
			expect(WINDOW_TEXEL_KM[k] / heights).toBeLessThanOrEqual(4);
			expect(cover).toBeLessThanOrEqual(heights);
		}
	});
});

describe('kmBetween', () => {
	it('measures great-circle distances', () => {
		expect(kmBetween([0, 0], [0, 1])).toBeCloseTo((6371 * Math.PI) / 180, 6);
		expect(kmBetween([10, 20], [10, 20])).toBe(0);
		expect(kmBetween([0, 179.5], [0, -179.5])).toBeCloseTo((6371 * Math.PI) / 180, 6);
	});
});
