import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { latLonToVector } from '../sun';
import { ancestorOf, keyOf, type Layer, Presence, type PyramidManifest, type TileKey, tileBounds } from './pyramid';
import { type Selection, TileSelector } from './select';

function manifest(absent: (layer: Layer, key: TileKey) => boolean = () => false): PyramidManifest {
	const levels: PyramidManifest['levels'] = {};
	for (const z of [2, 3, 4, 5]) {
		const columns = 24 * 2 ** (z - 2);
		const rows = columns / 2;
		const layers: PyramidManifest['levels'][string]['layers'] = {};
		for (const layer of z === 5 ? (['day'] as const) : (['day', 'night'] as const)) {
			const bits = new Uint8Array(Math.ceil((columns * rows) / 8));
			for (let y = 0; y < rows; y++) {
				for (let x = 0; x < columns; x++) {
					const i = y * columns + x;
					if (!absent(layer, { z, x, y })) bits[i >> 3] |= 1 << (i & 7);
				}
			}
			let binary = '';
			for (const byte of bits) binary += String.fromCharCode(byte);
			layers[layer] = { present: btoa(binary) };
		}
		levels[z] = { columns, rows, degrees: 360 / columns, layers };
	}
	return { version: 3, path: '{layer}/{z}/{x}-{y}.webp', tileTexels: 450, border: 1, maxLevel: 5, levels };
}

const FULL = manifest();
const BASE_TEXEL_KM = 40075 / 4096;

interface Pose {
	lat: number;
	lon: number;
	altitude: number;
	/** Look this many degrees of arc ahead toward the north, 0 straight down. */
	ahead?: number;
	/** Sun elevation at the camera's nadir, degrees, with the sun due east. */
	sun: number;
}

function select({ lat, lon, altitude, ahead = 0, sun }: Pose, pyramid = FULL, texelPixels = 2, aspect = 16 / 9): Selection {
	const height = 1080;
	const camera = new PerspectiveCamera(35, aspect, 0.0001, 100);
	const nadir = new Vector3(...latLonToVector(lat, lon));
	camera.position.copy(nadir).multiplyScalar(1 + altitude / 6371);
	camera.up.set(...latLonToVector(lat + 90, lon));
	camera.lookAt(ahead ? new Vector3(...latLonToVector(lat + ahead, lon)) : new Vector3());
	camera.updateMatrixWorld();
	const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
	const east = new Vector3(...latLonToVector(0, lon + 90));
	const elevation = (sun * Math.PI) / 180;
	const sunDir = nadir.clone().multiplyScalar(Math.sin(elevation)).addScaledVector(east, Math.cos(elevation)).normalize();
	const presence = new Presence(pyramid);
	const selector = new TileSelector(pyramid, { radius: 1, baseTexelKm: BASE_TEXEL_KM, texelPixels, has: (layer, key) => presence.has(layer, key) });
	return selector.select({ position: camera.position, frustum, sun: sunDir, scale: height / (2 * Math.tan((35 * Math.PI) / 360)) });
}

const tileAt = (lat: number, lon: number, z: number): TileKey => {
	const deg = 360 / (24 * 2 ** (z - 2));
	return { z, x: Math.floor((lon + 180) / deg), y: Math.floor((90 - lat) / deg) };
};
const ids = (tiles: { id: string }[]) => tiles.map((t) => t.id);
const levels = (tiles: { key: TileKey }[]) => [...new Set(tiles.map((t) => t.key.z))].sort();

const MATO_GROSSO = { lat: -6.77, lon: -59.48 };

describe('TileSelector', () => {
	it('wants nothing from the globe view', () => {
		const selection = select({ ...MATO_GROSSO, altitude: 20_000, sun: 40 });
		expect(selection).toEqual({ day: [], night: [] });
	});

	it('wants 500 m day tiles under the camera at 400 km in daylight', () => {
		const { day, night } = select({ ...MATO_GROSSO, altitude: 400, sun: 40 });
		expect(night).toEqual([]);
		expect(ids(day)).toContain(keyOf(tileAt(MATO_GROSSO.lat, MATO_GROSSO.lon, 5)));
		expect(levels(day)).toEqual([5]);
		expect(day.length).toBeGreaterThanOrEqual(4);
		expect(day.length).toBeLessThanOrEqual(16);
		for (const tile of day) expect(tile.distanceKm).toBeLessThan(700);
	});

	it('stops night lights at their finest level', () => {
		const { day, night } = select({ ...MATO_GROSSO, altitude: 400, sun: -40 });
		expect(day).toEqual([]);
		expect(levels(night)).toEqual([4]);
		expect(ids(night)).toContain(keyOf(tileAt(MATO_GROSSO.lat, MATO_GROSSO.lon, 4)));
	});

	it('wants both layers across twilight', () => {
		const { day, night } = select({ ...MATO_GROSSO, altitude: 400, sun: -5 });
		expect(day.length).toBeGreaterThan(0);
		expect(night.length).toBeGreaterThan(0);
	});

	it('refines less with a coarser pixel threshold', () => {
		const pose = { ...MATO_GROSSO, altitude: 400, sun: 40 };
		expect(levels(select(pose, FULL, 6).day)).toEqual([4]);
		expect(select(pose, FULL, 60).day).toEqual([]);
	});

	it('keeps coarser tiles toward the horizon', () => {
		const { day } = select({ ...MATO_GROSSO, altitude: 740, ahead: 8, sun: 40 });
		expect(levels(day).length).toBeGreaterThan(1);
		const byLevel = (z: number) => day.filter((t) => t.key.z === z).map((t) => t.distanceKm);
		expect(Math.max(...byLevel(5))).toBeLessThan(Math.min(...byLevel(3)));
	});

	it('keeps a parent where a child is absent, and never asks for the absent child', () => {
		const nadir = tileAt(MATO_GROSSO.lat, MATO_GROSSO.lon, 5);
		const pyramid = manifest((layer, key) => layer === 'day' && key.z === 5 && keyOf(key) === keyOf(nadir));
		const { day } = select({ ...MATO_GROSSO, altitude: 400, sun: 40 }, pyramid);
		expect(ids(day)).not.toContain(keyOf(nadir));
		expect(ids(day)).toContain(keyOf(ancestorOf(nadir, 4)));
	});

	it('wants nothing where the layer is absent at every level', () => {
		const pyramid = manifest((layer) => layer === 'day');
		expect(select({ ...MATO_GROSSO, altitude: 400, sun: 40 }, pyramid).day).toEqual([]);
	});

	it('wants only tiles on the visible side', () => {
		const { day } = select({ ...MATO_GROSSO, altitude: 400, sun: 40 });
		const camera = new Vector3(...latLonToVector(MATO_GROSSO.lat, MATO_GROSSO.lon));
		for (const { key } of day) {
			const b = tileBounds(key, FULL);
			const centre = new Vector3(...latLonToVector((b.north + b.south) / 2, (b.west + b.east) / 2));
			expect(centre.dot(camera)).toBeGreaterThan(0.99);
		}
	});

	it('wraps across the antimeridian', () => {
		const { day } = select({ lat: -17, lon: 179.95, altitude: 400, sun: 40 });
		const columns = day.map((t) => t.key.x);
		expect(columns).toContain(0);
		expect(columns).toContain(191);
	});

	it('works at the poles', () => {
		const { day } = select({ lat: 89.9, lon: 10, altitude: 400, sun: 20 });
		expect(day.length).toBeGreaterThan(0);
		expect(day.every((t) => t.key.y <= 1)).toBe(true);
		expect(new Set(day.map((t) => t.key.x)).size).toBeGreaterThan(20);
	});

	it('wants fewer tiles on a narrow phone screen', () => {
		const pose = { ...MATO_GROSSO, altitude: 400, sun: 40 };
		const desktop = select(pose).day.length;
		const phone = select(pose, FULL, 2, 393 / 852).day.length;
		expect(phone).toBeGreaterThan(0);
		expect(phone).toBeLessThan(desktop);
	});
});
