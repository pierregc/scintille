/** Tile pyramid layout and level selection for surface detail (#125 prototype). */

export interface PyramidLevel {
	columns: number;
	rows: number;
	degrees: number;
	layers: Record<Layer, { present: string }>;
}

export interface PyramidManifest {
	version: number;
	tileTexels: number;
	border: number;
	maxLevel: number;
	levels: Record<string, PyramidLevel>;
}

export type Layer = 'day' | 'night';

export interface TileKey {
	z: number;
	x: number;
	y: number;
}

export interface TileBounds {
	west: number;
	east: number;
	north: number;
	south: number;
}

export const KM_PER_DEG = 111.32;

export function tileBounds({ z, x, y }: TileKey, manifest: PyramidManifest): TileBounds {
	const deg = manifest.levels[z].degrees;
	const west = -180 + x * deg;
	const north = 90 - y * deg;
	return { west, east: west + deg, north, south: north - deg };
}

export function keyOf({ z, x, y }: TileKey): string {
	return `${z}/${x}-${y}`;
}

/** Which tiles of each layer exist; flat tiles (open water, unlit night) are left out of the pyramid. */
export class Presence {
	#bits = new Map<string, Uint8Array>();

	constructor(private readonly manifest: PyramidManifest) {
		for (const [z, level] of Object.entries(manifest.levels)) {
			for (const layer of ['day', 'night'] as const) {
				this.#bits.set(`${layer}${z}`, Uint8Array.from(atob(level.layers[layer].present), (c) => c.charCodeAt(0)));
			}
		}
	}

	has(layer: Layer, { z, x, y }: TileKey): boolean {
		const bits = this.#bits.get(`${layer}${z}`);
		if (!bits) return false;
		const index = y * this.manifest.levels[z].columns + x;
		return (bits[index >> 3] & (1 << (index & 7))) !== 0;
	}
}

/** Nearest point of a tile to a (lat, lon), as degrees. */
export function nearestPoint(bounds: TileBounds, lat: number, lon: number): [number, number] {
	const centre = (bounds.west + bounds.east) / 2;
	let relative = lon - centre;
	relative -= 360 * Math.round(relative / 360);
	const half = (bounds.east - bounds.west) / 2;
	return [Math.min(Math.max(lat, bounds.south), bounds.north), centre + Math.min(Math.max(relative, -half), half)];
}

/** Screen size in CSS pixels of one texel at `distanceKm`, for a vertical field of view and view height. */
export function texelPixels(texelKm: number, distanceKm: number, fovDeg: number, viewHeight: number): number {
	const kmPerPixel = (2 * distanceKm * Math.tan((fovDeg * Math.PI) / 360)) / viewHeight;
	return texelKm / kmPerPixel;
}
