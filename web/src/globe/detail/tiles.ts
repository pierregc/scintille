import { DataTexture, Frustum, Matrix4, NearestFilter, type PerspectiveCamera, RGBAFormat, type ShaderMaterial, UnsignedByteType, Vector3, Vector4 } from 'three';
import { type AtlasRenderer, emptyArray, TileAtlas } from './atlas';
import { DEFAULT_LOADER, type Patch, TileLoader, TileLoadError, type TileLoaderStats, type TileSource } from './loader';
import { type PagePatch, type PageSource, SurfacePages } from './pages';
import { finestLevel, type Layer, Presence, type PyramidManifest, texelKm, tileBytes, tilePath } from './pyramid';
import { RADIUS_KM, TileSelector } from './select';

export interface SurfaceTilesOptions {
	root: string;
	radius: number;
	/** Base Earth texel, km. */
	baseTexelKm: number;
	/** Refine while a texel covers more CSS pixels than this. */
	texelPixels: number;
	anisotropy: number;
	/** GPU bytes the tiles may hold. */
	maxBytes: number;
	fetch?: typeof fetch;
}

export type SurfaceTilesStats = TileLoaderStats & { manifest: 'loading' | 'ready' | 'failed'; layers: number; uploaded: number };

/** A decoded tile until it is copied to the GPU, then its layer in the tile array. */
export interface TileImage {
	bitmap: ImageBitmap | null;
	layer: number;
}

const MANIFEST_RETRY_MS = [2000, 5000, 15_000, 60_000];
/** Height growth per frame above which the camera counts as climbing: no new requests then. */
const CLIMB = 5e-4;
/** The array texture's layer index is one page byte. */
const MAX_LAYERS = 255;

/**
 * Linear mean of the 4k global textures over the tiles of each level, divided by the tiles' own:
 * the pyramid was downsampled from 15″ in sRGB, so its finer night levels hold more light. Scaling
 * the tiles keeps brightness and colour the same through level changes. Measured on every tile.
 */
export const DAY_GAIN = 0.98;
export const NIGHT_GAIN: Readonly<Record<number, readonly [number, number, number]>> = {
	2: [0.98, 0.99, 1],
	3: [0.95, 0.97, 1],
	4: [0.91, 0.95, 0.99],
};

/** Fetches and decodes one tile, rows from the south; HTTP status decides between retrying and giving up. */
export function imageSource(root: string, manifest: PyramidManifest, fetcher: typeof fetch = fetch, release: (image: TileImage) => void = () => {}): TileSource<TileImage> {
	const span = manifest.tileTexels + 2 * manifest.border;
	return {
		async load(layer, key, signal) {
			const res = await fetcher(`${root}/${tilePath(manifest, layer, key)}`, { signal });
			if (res.status === 429) {
				const seconds = Number(res.headers.get('retry-after'));
				throw new TileLoadError({ kind: 'throttled', retryAfterMs: seconds > 0 ? seconds * 1000 : undefined });
			}
			if ([403, 404, 410].includes(res.status)) throw new TileLoadError({ kind: 'missing' }, `${res.status}`);
			if (!res.ok) throw new TileLoadError({ kind: 'retry' }, `${res.status}`);
			const blob = await res.blob();
			let bitmap: ImageBitmap;
			try {
				bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
			} catch {
				throw new TileLoadError({ kind: 'missing' }, 'undecodable');
			}
			if (bitmap.width !== span || bitmap.height !== span) {
				bitmap.close();
				throw new TileLoadError({ kind: 'missing' }, 'wrong size');
			}
			return { bitmap, layer: -1 };
		},
		dispose(image) {
			image.bitmap?.close();
			image.bitmap = null;
			release(image);
		},
	};
}

/** Uniforms the Earth shader reads the surface detail from (`SURFACE` define). */
function surfaceUniforms() {
	return {
		surfaceTiles: { value: emptyArray() },
		surfacePages: { value: emptyPages() },
		surfaceGrid: { value: new Vector4(1, 1, 1, 0) },
		surfaceFinest: { value: 0 },
		surfaceOn: { value: 0 },
		surfaceDayGain: { value: DAY_GAIN },
		surfaceNightGain: { value: Array.from({ length: 6 }, (_, z) => new Vector3(...(NIGHT_GAIN[z] ?? [1, 1, 1]))) },
	};
}

function emptyPages(): DataTexture {
	return pageTexture(new Uint8Array(8), 2, 1);
}

function pageTexture(data: Uint8Array, width: number, height: number): DataTexture {
	const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
	texture.minFilter = NearestFilter;
	texture.magFilter = NearestFilter;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	return texture;
}

/**
 * Visible surface detail (ADR 0022), drawn by the Earth shader in one pass: loaded tiles live in
 * one texture array, and a page table per finest cell names the tile shown there for day and night
 * and the one it fades from.
 */
export class SurfaceTiles {
	readonly uniforms = surfaceUniforms();
	#manifest: PyramidManifest | null = null;
	#selector: TileSelector | null = null;
	#loader: TileLoader<TileImage> | null = null;
	#pages: SurfacePages | null = null;
	#atlas: TileAtlas | null = null;
	#state: SurfaceTilesStats['manifest'] = 'loading';
	#frustum = new Frustum();
	#matrix = new Matrix4();
	#lastHeight = Number.NaN;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;
	#maxBytes: number;
	#uploaded = 0;

	#online = () => this.#loader?.retryNow();

	constructor(private readonly renderer: AtlasRenderer, earth: ShaderMaterial, private readonly options: SurfaceTilesOptions) {
		this.#maxBytes = options.maxBytes;
		earth.defines = { ...earth.defines, SURFACE: '' };
		Object.assign(earth.uniforms, this.uniforms);
		earth.needsUpdate = true;
		this.#fetchManifest(0);
		globalThis.addEventListener?.('online', this.#online);
	}

	get stats(): SurfaceTilesStats | null {
		return this.#loader
			? { ...this.#loader.stats, manifest: this.#state, layers: this.#atlas?.layers ?? 0, uploaded: this.#uploaded }
			: null;
	}

	set maxBytes(bytes: number) {
		this.#maxBytes = bytes;
		if (bytes <= 0) {
			this.clear();
			this.#dropAtlas();
		}
		if (this.#loader) this.#loader.maxBytes = this.#capacity();
	}

	#capacity(): number {
		const manifest = this.#manifest;
		if (!manifest || !this.#atlas) return this.#maxBytes;
		return Math.min(this.#maxBytes, this.#atlas.layers * tileBytes(manifest));
	}

	#fetchManifest(attempt: number) {
		const fetcher = this.options.fetch ?? fetch;
		void fetcher(`${this.options.root}/manifest.json`)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`manifest ${res.status}`))))
			.then((manifest: PyramidManifest) => {
				if (this.#disposed) return;
				this.#init(manifest);
			})
			.catch((error: unknown) => {
				if (this.#disposed) return;
				this.#state = 'failed';
				console.warn('surface tiles:', error);
				this.#retry = setTimeout(() => this.#fetchManifest(attempt + 1), MANIFEST_RETRY_MS[Math.min(attempt, MANIFEST_RETRY_MS.length - 1)]);
			});
	}

	#init(manifest: PyramidManifest) {
		const presence = new Presence(manifest);
		const levels = Object.keys(manifest.levels).map(Number);
		const finest = Math.max(...levels);
		const loader = new TileLoader(imageSource(this.options.root, manifest, this.options.fetch, (image) => this.#release(image)), {
			...DEFAULT_LOADER,
			coarsest: Math.min(...levels),
			finest: { day: finestLevel(manifest, 'day'), night: finestLevel(manifest, 'night') },
			texelKm: (z) => texelKm(manifest, z),
			baseTexelKm: this.options.baseTexelKm,
			tileBytes: tileBytes(manifest),
			maxBytes: this.#maxBytes,
		});
		this.#selector = new TileSelector(manifest, {
			radius: this.options.radius,
			baseTexelKm: this.options.baseTexelKm,
			texelPixels: this.options.texelPixels,
			has: (layer: Layer, key) => presence.has(layer, key) && !loader.isMissing(layer, key),
		});
		const { columns, rows } = manifest.levels[finest];
		const pages = new SurfacePages(columns, rows, finest);
		this.uniforms.surfacePages.value.dispose();
		this.uniforms.surfacePages.value = pageTexture(pages.data, columns * 2, rows);
		this.uniforms.surfaceGrid.value.set(columns, rows, manifest.tileTexels, manifest.border);
		this.uniforms.surfaceFinest.value = finest;
		this.#manifest = manifest;
		this.#loader = loader;
		this.#pages = pages;
		this.#state = 'ready';
	}

	update(camera: PerspectiveCamera, viewHeight: number, sun: Vector3): void {
		const manifest = this.#manifest;
		const selector = this.#selector;
		const loader = this.#loader;
		const pages = this.#pages;
		if (!manifest || !selector || !loader || !pages || this.#disposed) return;
		this.#matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.#frustum.setFromProjectionMatrix(this.#matrix);
		const heightKm = (camera.position.length() / this.options.radius - 1) * RADIUS_KM;
		const hold = heightKm > this.#lastHeight * (1 + CLIMB);
		this.#lastHeight = heightKm;
		const scale = viewHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
		const selection = this.#maxBytes > 0 ? selector.select({ position: camera.position, frustum: this.#frustum, sun, scale }) : { day: [], night: [] };
		const patches = loader.update(selection, { hold, scale });
		if (pages.update(this.#place(patches, manifest), performance.now())) this.uniforms.surfacePages.value.needsUpdate = true;
		this.uniforms.surfaceOn.value = pages.active ? 1 : 0;
	}

	/** Page sources of the patches, copying newly arrived tiles to the GPU. */
	#place(patches: Patch<TileImage>[], manifest: PyramidManifest): PagePatch[] {
		const placed: PagePatch[] = [];
		for (const { key, day, night } of patches) {
			const d = day && this.#upload(day.resource, day.key.z, manifest);
			const n = night && this.#upload(night.resource, night.key.z, manifest);
			if (d || n) placed.push({ key, day: d, night: n });
		}
		return placed;
	}

	#upload(image: TileImage, z: number, manifest: PyramidManifest): PageSource | undefined {
		if (image.layer < 0) {
			if (!image.bitmap) return undefined;
			const atlas = this.#ensureAtlas(manifest);
			const layer = atlas?.upload(image.bitmap) ?? null;
			if (layer === null) return undefined;
			image.bitmap.close();
			image.bitmap = null;
			image.layer = layer;
			this.#uploaded++;
		}
		return { layer: image.layer, z };
	}

	/** The tile array, allocated once the first tile is needed, for as many tiles as the budget holds. */
	#ensureAtlas(manifest: PyramidManifest): TileAtlas | null {
		if (this.#atlas) return this.#atlas;
		const layers = Math.min(MAX_LAYERS, Math.floor(this.#maxBytes / tileBytes(manifest)));
		if (layers < 1) return null;
		this.#atlas = new TileAtlas(this.renderer, layers, manifest.tileTexels + 2 * manifest.border, this.options.anisotropy);
		this.uniforms.surfaceTiles.value.dispose();
		this.uniforms.surfaceTiles.value = this.#atlas.texture;
		if (this.#loader) this.#loader.maxBytes = this.#capacity();
		return this.#atlas;
	}

	#release(image: TileImage) {
		if (image.layer < 0) return;
		this.#pages?.release(image.layer);
		this.#atlas?.free(image.layer);
		image.layer = -1;
	}

	#dropAtlas() {
		if (!this.#atlas) return;
		this.uniforms.surfaceTiles.value = emptyArray();
		this.#atlas.dispose();
		this.#atlas = null;
	}

	/** Drops every tile and request at once; tiles known to be missing stay known. */
	clear(): void {
		this.#loader?.clear();
		this.#pages?.clear();
		this.uniforms.surfacePages.value.needsUpdate = true;
		this.uniforms.surfaceOn.value = 0;
	}

	dispose(): void {
		this.#disposed = true;
		globalThis.removeEventListener?.('online', this.#online);
		clearTimeout(this.#retry);
		this.#loader?.dispose();
		this.#dropAtlas();
		this.uniforms.surfaceTiles.value.dispose();
		this.uniforms.surfacePages.value.dispose();
	}
}
