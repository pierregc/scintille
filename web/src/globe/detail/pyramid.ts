/** Tile pyramid layout and level selection for surface detail (ADR 0022). */

export interface PyramidLevel {
	columns: number;
	rows: number;
	degrees: number;
	/** A layer is absent from the levels finer than its source: night stops at level 4. */
	layers: Partial<Record<Layer, { present: string }>>;
}

export interface PyramidManifest {
	version: number;
	/** Tile path template, e.g. `{layer}/{z}/{x}-{y}.webp`. */
	path?: string;
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

export function tilePath(manifest: PyramidManifest, layer: Layer, { z, x, y }: TileKey): string {
	return (manifest.path ?? '{layer}/{z}/{x}-{y}.webp')
		.replace('{layer}', layer)
		.replace('{z}', String(z))
		.replace('{x}', String(x))
		.replace('{y}', String(y));
}

/** Ancestor of a tile at level `z` (the tile itself when `z` is its own level). */
export function ancestorOf({ z, x, y }: TileKey, level: number): TileKey {
	const shift = z - level;
	return shift > 0 ? { z: level, x: x >> shift, y: y >> shift } : { z, x, y };
}

export function childrenOf({ z, x, y }: TileKey): TileKey[] {
	return [0, 1].flatMap((dy) => [0, 1].map((dx) => ({ z: z + 1, x: 2 * x + dx, y: 2 * y + dy })));
}

/** Offset and scale of a tile inside one of its ancestors, in texture coordinates (v up). */
export function rectIn({ z, x, y }: TileKey, ancestor: TileKey): [number, number, number] {
	const n = 2 ** (z - ancestor.z);
	return [(x % n) / n, (n - 1 - (y % n)) / n, 1 / n];
}

/** Finest level a layer exists at. */
export function finestLevel(manifest: PyramidManifest, layer: Layer): number {
	let finest = -1;
	for (const [z, level] of Object.entries(manifest.levels)) if (level.layers[layer]) finest = Math.max(finest, Number(z));
	return finest;
}

export function texelKm(manifest: PyramidManifest, z: number): number {
	return (manifest.levels[z].degrees / manifest.tileTexels) * KM_PER_DEG;
}

/** GPU bytes of one RGBA8 tile with its mipmaps. */
export function tileBytes(manifest: PyramidManifest): number {
	let size = manifest.tileTexels + 2 * manifest.border;
	let bytes = 0;
	for (;;) {
		bytes += size * size * 4;
		if (size === 1) return bytes;
		size = Math.max(1, size >> 1);
	}
}

/** Which tiles of each layer exist; flat tiles (open water, unlit night) are left out of the pyramid. */
export class Presence {
	#bits = new Map<string, Uint8Array>();

	constructor(private readonly manifest: PyramidManifest) {
		for (const [z, level] of Object.entries(manifest.levels)) {
			for (const layer of ['day', 'night'] as const) {
				const present = level.layers[layer]?.present;
				if (present !== undefined) this.#bits.set(`${layer}${z}`, Uint8Array.from(atob(present), (c) => c.charCodeAt(0)));
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
