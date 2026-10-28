import { describe, expect, it } from 'vitest';
import { nearestPoint, Presence, type PyramidManifest, texelPixels, tileBounds } from './pyramid';

const level = (columns: number, present: number[]) => {
	const bits = new Uint8Array(Math.ceil((columns * columns) / 2 / 8));
	for (const i of present) bits[i >> 3] |= 1 << (i & 7);
	const encoded = btoa(String.fromCharCode(...bits));
	return { columns, rows: columns / 2, degrees: 360 / columns, layers: { day: { present: encoded }, night: { present: '' } } };
};

const manifest: PyramidManifest = { version: 1, tileTexels: 450, border: 1, maxLevel: 5, levels: { 2: level(24, [0, 25]), 5: level(192, []) } };

describe('tileBounds', () => {
	it('starts at 180° W and the north pole', () => {
		expect(tileBounds({ z: 2, x: 0, y: 0 }, manifest)).toEqual({ west: -180, east: -165, north: 90, south: 75 });
		expect(tileBounds({ z: 5, x: 191, y: 95 }, manifest)).toEqual({ west: 178.125, east: 180, north: -88.125, south: -90 });
	});
});

describe('Presence', () => {
	it('reads the bitset row by row', () => {
		const presence = new Presence(manifest);
		expect(presence.has('day', { z: 2, x: 0, y: 0 })).toBe(true);
		expect(presence.has('day', { z: 2, x: 1, y: 1 })).toBe(true);
		expect(presence.has('day', { z: 2, x: 1, y: 0 })).toBe(false);
		expect(presence.has('night', { z: 2, x: 0, y: 0 })).toBe(false);
		expect(presence.has('day', { z: 3, x: 0, y: 0 })).toBe(false);
	});
});

describe('nearestPoint', () => {
	const bounds = { west: 170, east: 180, north: 10, south: 0 };
	it('clamps inside the tile', () => {
		expect(nearestPoint(bounds, 20, 175)).toEqual([10, 175]);
	});
	it('wraps across the antimeridian', () => {
		expect(nearestPoint(bounds, 5, -179)).toEqual([5, 180]);
		expect(nearestPoint(bounds, 5, -100)).toEqual([5, 180]);
	});
});

describe('texelPixels', () => {
	it('matches the immersive view scale at the ISS pose', () => {
		// 400 km, 35° vertical field of view, 1080 px: 0.23 km per CSS px.
		expect(texelPixels(0.5, 400, 35, 1080)).toBeCloseTo(2.1, 1);
	});
});
