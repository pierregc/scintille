import { describe, expect, it } from 'vitest';
import { WIND_RULES } from '../../contract/wind';
import { cloudVeil, dayShare, decodeWindByte, easeFade, fibreCellKm, fibreOctave, heightFade, WIND_FADE, WIND_LOOKS, windUv } from './look';
import { WIND_LOOK_LEVEL } from './types';

describe('wind texels', () => {
	it('decodes bytes around 128, calm', () => {
		expect(decodeWindByte(128, 40)).toBe(0);
		expect(decodeWindByte(255, 40)).toBe(40);
		expect(decodeWindByte(1, 120)).toBe(-120);
		expect(decodeWindByte(128 + 127 / 4, 120)).toBeCloseTo(30);
	});

	it('maps latitude and longitude to texel centres, 90° N at the top and 0° E on the left', () => {
		const [w, h] = [WIND_RULES.width, WIND_RULES.height];
		expect(windUv(90, 0)).toEqual([0.5 / w, 1 - 0.5 / h]);
		expect(windUv(-90, 0)[1]).toBeCloseTo(0.5 / h);
		expect(windUv(0, 180)).toEqual([360.5 / w, 1 - 180.5 / h]);
		expect(windUv(0, 0)[1]).toBeCloseTo(0.5);
		expect(windUv(10, -0.5)[0]).toBeCloseTo((w - 0.5) / w);
		expect(windUv(45, 370)[0]).toBeCloseTo(windUv(45, 10)[0]);
	});
});

describe('wind looks', () => {
	it('draws the jet stream from 250 hPa and the veil from 10 m', () => {
		expect(WIND_LOOK_LEVEL.jet).toBe('250hPa');
		expect(WIND_LOOK_LEVEL.surface).toBe('10m');
	});

	it('keeps the jet ribbons to strong winds, high and faint', () => {
		const { jet, surface } = WIND_LOOKS;
		expect(jet.calm).toBe(28);
		expect(jet.heightKm).toBeGreaterThan(surface.heightKm);
		expect(jet.gain).toBeLessThanOrEqual(0.5);
		expect(jet.sparse).toBeGreaterThan(surface.sparse);
	});

	it('lifts the veil off clouds in daylight only', () => {
		const veil = WIND_LOOKS.surface.cloudVeil;
		expect(veil).toBe(1);
		expect(cloudVeil(0.8, 1, veil)).toBe(0);
		expect(cloudVeil(0.8, 0, veil)).toBe(1);
		expect(cloudVeil(0, 1, veil)).toBe(1);
		expect(cloudVeil(WIND_FADE.cloudOpaque / 2, 1, veil)).toBeCloseTo(1 - veil / 2);
		expect(WIND_LOOKS.jet.cloudVeil).toBe(0);
	});

	it('reads daylight around the terminator', () => {
		expect(dayShare(-0.5)).toBe(0);
		expect(dayShare(0.5)).toBe(1);
		expect(dayShare(0.075)).toBeCloseTo(0.5);
	});

	it('keeps fibres a few pixels wide, resolved by the bake and bounded on the ground', () => {
		expect(fibreCellKm(10, 10, 2.5)).toBe(25);
		expect(fibreCellKm(10, 20, 2.5)).toBe(44);
		expect(fibreCellKm(0.1, 0.1, 2.5)).toBe(1.5);
		expect(fibreCellKm(100, 100, 2.5)).toBe(60);
	});

	it('blends two noise octaves continuously with the fibre width', () => {
		const at = (km: number) => fibreOctave(km);
		expect(at(6371 / 256)).toEqual({ lo: 256, blend: 0, cell: 1 / 256 });
		const half = at(6371 / 362);
		expect(half.lo).toBe(256);
		expect(half.blend).toBeCloseTo(0.5, 2);
		expect(at(6371 / 511.9).cell).toBeCloseTo(at(6371 / 512.1).cell, 5);
	});
});

describe('wind fades', () => {
	it('fades out close up, where fibres read as rain', () => {
		expect(heightFade(WIND_FADE.goneKmPerPx)).toBe(0);
		expect(heightFade(0.2)).toBe(0);
		expect(heightFade(WIND_FADE.wholeKmPerPx)).toBe(1);
		expect(heightFade(10)).toBe(1);
		expect(heightFade((WIND_FADE.goneKmPerPx + WIND_FADE.wholeKmPerPx) / 2)).toBeCloseTo(0.5);
	});

	it('eases in and out of storm views at a constant rate', () => {
		expect(easeFade(1, 0, WIND_FADE.stormMs / 4, WIND_FADE.stormMs)).toBeCloseTo(0.75);
		expect(easeFade(0.1, 0, WIND_FADE.stormMs, WIND_FADE.stormMs)).toBe(0);
		expect(easeFade(0.9, 1, 1000, WIND_FADE.stormMs)).toBe(1);
		expect(easeFade(0.5, 1, -50, WIND_FADE.stormMs)).toBe(0.5);
		expect(easeFade(0.5, 0, 0, 0)).toBe(0);
	});
});
