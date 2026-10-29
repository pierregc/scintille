import type { PerspectiveCamera, ShaderMaterial, Vector3 } from 'three';
import { SurfaceTiles, type SurfaceTilesStats } from './tiles';
import { SurfaceVectors } from './vectors';

/** Surface detail prototypes compared in #125: base textures only, raster tiles, vector overlays, or both. */
export type SurfaceMode = 'base' | 'tiles' | 'vectors' | 'both';
export const SURFACE_MODES: readonly SurfaceMode[] = ['base', 'tiles', 'vectors', 'both'];

/** `?surface=base|tiles|vectors|both`, and `?texel=<css px>` for the refinement threshold. */
export function surfaceFromSearch(search: string): { mode: SurfaceMode; texelPixels: number } {
	const params = new URLSearchParams(search);
	const mode = params.get('surface') as SurfaceMode;
	const texel = Number(params.get('texel'));
	return { mode: SURFACE_MODES.includes(mode) ? mode : 'base', texelPixels: texel > 0 ? texel : 2 };
}

export interface SurfaceDetailOptions {
	earth: ShaderMaterial;
	root: string;
	surfaceRoot: string;
	radius: number;
	baseTexelKm: number;
	anisotropy: number;
	pixelRatio: () => number;
	mode: SurfaceMode;
	texelPixels: number;
	/** GPU bytes the tiles may hold. */
	maxBytes: number;
}

export class SurfaceDetail {
	readonly tiles: SurfaceTiles;
	readonly vectors: SurfaceVectors;
	#mode: SurfaceMode;

	constructor(private readonly options: SurfaceDetailOptions) {
		this.#mode = options.mode;
		this.tiles = new SurfaceTiles(options.earth, {
			root: options.surfaceRoot,
			radius: options.radius,
			baseTexelKm: options.baseTexelKm,
			texelPixels: options.texelPixels,
			anisotropy: options.anisotropy,
			maxBytes: options.maxBytes,
		});
		this.vectors = new SurfaceVectors(`${options.root}/vectors/lines.bin`, options.radius, options.earth.uniforms.sunDirection.value as Vector3, options.pixelRatio);
	}

	get mode(): SurfaceMode {
		return this.#mode;
	}

	set mode(mode: SurfaceMode) {
		this.#mode = mode;
		if (mode === 'base' || mode === 'vectors') this.tiles.clear();
	}

	update(camera: PerspectiveCamera, viewHeight: number): void {
		const tiles = this.#mode === 'tiles' || this.#mode === 'both';
		const vectors = this.#mode === 'vectors' || this.#mode === 'both';
		this.tiles.group.visible = tiles;
		if (tiles) this.tiles.update(camera, viewHeight, this.options.earth.uniforms.sunDirection.value as Vector3);
		const heightKm = (camera.position.length() / this.options.radius - 1) * 6371;
		if (vectors) this.vectors.update(heightKm);
		else this.vectors.group.visible = false;
	}

	stats(): { mode: SurfaceMode; tiles: SurfaceTilesStats | null; vectors: boolean } {
		return { mode: this.#mode, tiles: this.tiles.stats, vectors: this.vectors.loaded };
	}

	dispose(): void {
		this.tiles.dispose();
		this.vectors.dispose();
	}
}
