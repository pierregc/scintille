import { describe, expect, it } from 'vitest';
import { intensityScale } from './intensity';
import { bloomStrength, channelReveal, farness, glowRadiusKm, glowShare, PHONE, viewScale, ZOOM } from './zoom';

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

	it('lets the lit cloud and the channels carry the flash near the floor', () => {
		expect(glowShare(POSES.iss)).toBe(0.15);
		expect(glowShare(ZOOM.farKmPerPx)).toBe(1);
		expect(glowShare(POSES.globe)).toBe(1);
		expect(glowShare(POSES.iss, ZOOM.nearGlowAlone)).toBe(0.4);
	});

	it('keeps a tenth of the bloom near the floor and the far sizes unchanged', () => {
		expect(bloomStrength(POSES.iss, 0.9)).toBeCloseTo(0.09, 9);
		expect(bloomStrength(POSES.globe, 0.9)).toBeCloseTo(0.9, 9);
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
	});
});
