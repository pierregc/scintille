import { describe, expect, it } from 'vitest';
import { intensityScale } from './intensity';
import { bloomRadius, bloomStrength, channelReveal, farness, glowRadiusKm, glowShare, maxBlendShare, nearFloor, PHONE, viewScale, ZOOM } from './zoom';

const POSES = { globe: 11.7, mid: 1.2, regional: 0.51, window: 0.3, iss: 0.23 };

describe('flash size with zoom', () => {
	it('keeps distant flashes as points with the full compensation', () => {
		expect(farness(POSES.globe)).toBe(1);
		for (const i of [0, 0.5, 1]) {
			expect(glowRadiusKm(8, i, POSES.globe) / POSES.globe).toBeCloseTo(ZOOM.pointPx * intensityScale(i), 6);
			expect(glowRadiusKm(30, i, 5)).toBeCloseTo(30 * ZOOM.farGlow * intensityScale(i), 6);
		}
	});

	it('keeps the glow within one to two observed radii near the floor', () => {
		for (const kmPerPx of [POSES.iss, POSES.window]) {
			expect(farness(kmPerPx)).toBe(0);
			expect(glowRadiusKm(8, 0, kmPerPx)).toBeCloseTo(8, 6);
			expect(glowRadiusKm(8, 1, kmPerPx)).toBeCloseTo(16, 6);
		}
	});

	it('changes size smoothly and keeps stronger and larger flashes bigger', () => {
		let previous = glowRadiusKm(8, 0.5, 0.2);
		for (let kmPerPx = 0.2; kmPerPx < 20; kmPerPx *= 1.02) {
			const size = glowRadiusKm(8, 0.5, kmPerPx);
			expect(size / previous).toBeLessThan(1.1);
			expect(size).toBeGreaterThanOrEqual(previous);
			expect(glowRadiusKm(8, 0.9, kmPerPx)).toBeGreaterThan(glowRadiusKm(8, 0.1, kmPerPx));
			expect(glowRadiusKm(12, 0.5, kmPerPx)).toBeGreaterThanOrEqual(size);
			previous = size;
		}
	});

	it('reveals channels as their physical length becomes readable', () => {
		expect(channelReveal(8, POSES.globe)).toBe(0);
		expect(channelReveal(8, POSES.regional)).toBe(1);
		expect(channelReveal(8, POSES.iss)).toBe(1);
		const mid = channelReveal(8, POSES.mid);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
	});

	it('applies the rules of the floor below 1 km per px only', () => {
		expect(nearFloor(POSES.iss)).toBe(1);
		expect(nearFloor(POSES.window)).toBe(1);
		expect(nearFloor(ZOOM.floorKmPerPx)).toBe(0);
		expect(nearFloor(POSES.mid)).toBe(0);
		let previous = 1;
		for (let kmPerPx = 0.3; kmPerPx < 1.1; kmPerPx *= 1.02) {
			const weight = nearFloor(kmPerPx);
			expect(weight).toBeLessThanOrEqual(previous);
			expect(previous - weight).toBeLessThan(0.05);
			previous = weight;
		}
	});

	it('fades the screen blend in over the max blend from 0.7 to 1 km per px', () => {
		expect(maxBlendShare(POSES.iss)).toBe(1);
		expect(maxBlendShare(ZOOM.blendFromKmPerPx)).toBe(1);
		expect(maxBlendShare(ZOOM.floorKmPerPx)).toBe(0);
		expect(maxBlendShare(POSES.mid)).toBe(0);
		let previous = 1;
		for (let kmPerPx = ZOOM.blendFromKmPerPx; kmPerPx < 1.05; kmPerPx *= 1.01) {
			const share = maxBlendShare(kmPerPx);
			expect(share).toBeLessThanOrEqual(previous);
			expect(previous - share).toBeLessThan(0.06);
			previous = share;
		}
	});

	it('lets the lit cloud and the channels carry the flash near the floor', () => {
		expect(glowShare(POSES.iss)).toBe(0.15);
		expect(glowShare(ZOOM.farKmPerPx)).toBe(1);
		expect(glowShare(POSES.globe)).toBe(1);
		expect(glowShare(POSES.iss, ZOOM.glowLevel)).toBe(0.4);
		for (const kmPerPx of [ZOOM.floorKmPerPx, POSES.mid, 2]) {
			expect(glowShare(kmPerPx)).toBeCloseTo(0.4 + 0.6 * farness(kmPerPx), 9);
		}
		expect(glowShare(POSES.regional)).toBeGreaterThan(0.15);
		expect(glowShare(POSES.regional)).toBeLessThan(0.4 + 0.6 * farness(POSES.regional));
	});

	it('keeps a tenth of the bloom, tightened, near the floor and the far sizes unchanged', () => {
		expect(bloomStrength(POSES.iss, 0.9)).toBeCloseTo(0.09, 9);
		expect(bloomStrength(POSES.globe, 0.9)).toBeCloseTo(0.9, 9);
		expect(bloomRadius(POSES.iss, 0.4, 0.55)).toBe(0.4);
		expect(bloomRadius(POSES.mid, 0.4, 0.55)).toBe(0.55);
		expect(bloomRadius(POSES.globe, 0.4, 0.55)).toBe(0.55);
		for (const i of [0, 0.5, 1]) {
			expect(glowRadiusKm(8, i, ZOOM.farKmPerPx)).toBeCloseTo(Math.max(8 * ZOOM.farGlow, ZOOM.pointPx * ZOOM.farKmPerPx) * intensityScale(i), 6);
		}
	});

	it('draws a phone as a shrunk 1080 px tall view, with the point floor kept in CSS px', () => {
		expect(viewScale(1080, false)).toBe(1);
		expect(viewScale(659, false)).toBe(1);
		expect(viewScale(1440, true)).toBe(1);
		const scale = viewScale(659, true);
		expect(scale).toBeCloseTo(659 / PHONE.viewHeight, 6);
		const phoneKmPerPx = POSES.window / scale;
		expect(glowRadiusKm(8, 0.5, phoneKmPerPx, scale)).toBeCloseTo(glowRadiusKm(8, 0.5, POSES.window), 6);
		expect(glowRadiusKm(8, 0.5, POSES.globe, scale)).toBeCloseTo(glowRadiusKm(8, 0.5, POSES.globe), 6);
		expect(glowShare(POSES.iss, ZOOM.nearGlowLevel * PHONE.nearLevel)).toBeLessThan(glowShare(POSES.iss));
		expect(glowShare(POSES.globe, ZOOM.nearGlowLevel * PHONE.nearLevel)).toBe(1);
		const near = ZOOM.nearGlowLevel * PHONE.nearLevel;
		const ramp = ZOOM.glowLevel * PHONE.nearLevel;
		expect(near).toBeCloseTo(0.09, 9);
		expect(ramp).toBeCloseTo(0.24, 9);
		expect(glowShare(POSES.iss, near, ramp)).toBeCloseTo(0.09, 9);
		for (const kmPerPx of [ZOOM.floorKmPerPx, POSES.mid, 2, ZOOM.farKmPerPx]) {
			expect(glowShare(kmPerPx, near, ramp)).toBeCloseTo(0.24 + 0.76 * farness(kmPerPx), 9);
		}
	});
});
