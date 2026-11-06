import type { PerspectiveCamera, ShaderMaterial, Vector3 } from 'three';
import type { AtlasRenderer } from './atlas';
import { SurfaceTiles, type SurfaceTilesStats } from './tiles';

/** Surface detail: raster tiles (ADR 0022), or the base textures alone to compare against. */
export type SurfaceMode = 'base' | 'tiles';
export const SURFACE_MODES: readonly SurfaceMode[] = ['tiles', 'base'];

/** `?surface=tiles|base`, and `?texel=<css px>` for the refinement threshold. */
export function surfaceFromSearch(search: string): { mode: SurfaceMode; texelPixels: number } {
	const params = new URLSearchParams(search);
	const mode = params.get('surface') as SurfaceMode;
	const texel = Number(params.get('texel'));
	return { mode: SURFACE_MODES.includes(mode) ? mode : 'tiles', texelPixels: texel > 0 ? texel : 2 };
}

export interface SurfaceDetailOptions {
	renderer: AtlasRenderer;
	earth: ShaderMaterial;
	surfaceRoot: string;
	radius: number;
	baseTexelKm: number;
	anisotropy: number;
	mode: SurfaceMode;
	texelPixels: number;
	/** GPU bytes the tiles may hold. */
	maxBytes: number;
}

export class SurfaceDetail {
	readonly tiles: SurfaceTiles;
	#mode: SurfaceMode;

	constructor(private readonly options: SurfaceDetailOptions) {
		this.#mode = options.mode;
		this.tiles = new SurfaceTiles(options.renderer, options.earth, {
			root: options.surfaceRoot,
			radius: options.radius,
			baseTexelKm: options.baseTexelKm,
			texelPixels: options.texelPixels,
			anisotropy: options.anisotropy,
			maxBytes: options.maxBytes,
		});
	}

	get mode(): SurfaceMode {
		return this.#mode;
	}

	set mode(mode: SurfaceMode) {
		this.#mode = mode;
		if (mode === 'base') this.tiles.clear();
	}

	update(camera: PerspectiveCamera, viewHeight: number): void {
		if (this.#mode === 'tiles') this.tiles.update(camera, viewHeight, this.options.earth.uniforms.sunDirection.value as Vector3);
	}

	stats(): { mode: SurfaceMode; tiles: SurfaceTilesStats | null } {
		return { mode: this.#mode, tiles: this.tiles.stats };
	}

	dispose(): void {
		this.tiles.dispose();
	}
}
