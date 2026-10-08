import { describe, expect, it } from 'vitest';
import { latLonToVector, subsolarPoint, sunDirection } from './sun';

// Reference: JPL Horizons apparent geocentric Sun Dec, and RA minus Greenwich apparent sidereal time.
const references = [
	{ name: 'March equinox 2024', utc: '2024-03-20T03:06:00Z', lat: 0.0, lon: 135.3548 },
	{ name: 'June solstice 2024', utc: '2024-06-20T20:51:00Z', lat: 23.4382, lon: -132.3036 },
	{ name: 'December solstice 2024', utc: '2024-12-21T09:20:00Z', lat: -23.4384, lon: 39.5587 },
	{ name: 'random date 2025', utc: '2025-08-14T16:37:00Z', lat: 14.1289, lon: -68.0976 },
	{ name: 'random date 2031', utc: '2031-02-03T05:12:00Z', lat: -16.5758, lon: 105.4328 },
];

const TOLERANCE_DEG = 0.1;

const angleBetweenDeg = (a: number[], b: number[]) =>
	(Math.acos(Math.min(1, a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0))) * 180) / Math.PI;

describe('subsolarPoint', () => {
	it.each(references)('matches the reference at $name', ({ utc, lat, lon }) => {
		const point = subsolarPoint(new Date(utc));
		expect(Math.abs(point.lat - lat)).toBeLessThan(TOLERANCE_DEG);
		expect(Math.abs(point.lon - lon)).toBeLessThan(TOLERANCE_DEG);
	});

	it('keeps longitude in [-180, 180)', () => {
		for (let hour = 0; hour < 24; hour++) {
			const { lon } = subsolarPoint(new Date(Date.UTC(2026, 0, 1, hour)));
			expect(lon).toBeGreaterThanOrEqual(-180);
			expect(lon).toBeLessThan(180);
		}
	});
});

describe('sunDirection', () => {
	it.each(references)('points at the reference subsolar point at $name', ({ utc, lat, lon }) => {
		const direction = sunDirection(new Date(utc));
		expect(Math.hypot(...direction)).toBeCloseTo(1, 12);
		expect(angleBetweenDeg(direction, latLonToVector(lat, lon))).toBeLessThan(TOLERANCE_DEG);
	});

	it('maps lat/lon to Y-up globe axes', () => {
		const expectAxis = (v: number[], axis: number[]) => v.forEach((c, i) => expect(c).toBeCloseTo(axis[i] ?? 0, 12));
		expectAxis(latLonToVector(90, 0), [0, 1, 0]);
		expectAxis(latLonToVector(0, 0), [1, 0, 0]);
		expectAxis(latLonToVector(0, 90), [0, 0, -1]);
	});
});
