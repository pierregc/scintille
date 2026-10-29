import {
	DataTexture,
	Frustum,
	Group,
	LinearMipmapLinearFilter,
	Matrix4,
	Mesh,
	type PerspectiveCamera,
	ShaderMaterial,
	SphereGeometry,
	SRGBColorSpace,
	Texture,
	Vector2,
	Vector3,
	Vector4,
} from 'three';
import { DEFAULT_LOADER, type Patch, TileLoader, TileLoadError, type TileLoaderStats, type TileSource } from './loader';
import { finestLevel, type Layer, Presence, type PyramidManifest, rectIn, texelKm, tileBounds, tileBytes, tilePath } from './pyramid';
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

export type SurfaceTilesStats = TileLoaderStats & { manifest: 'loading' | 'ready' | 'failed' };

interface Drawn {
	mesh: Mesh;
	material: ShaderMaterial;
	shownAt: number;
}

const MANIFEST_RETRY_MS = [2000, 5000, 15_000, 60_000];
const MESH_KEEP_MS = 3000;
const MAX_MESHES = 256;
/** Height growth per frame above which the camera counts as climbing: no new requests then. */
const CLIMB = 5e-4;
const WHOLE: [number, number, number] = [0, 0, 1];

/** Fetches, decodes and disposes one tile texture; HTTP status decides between retrying and giving up. */
export function textureSource(root: string, manifest: PyramidManifest, anisotropy: number, fetcher: typeof fetch = fetch): TileSource<Texture> {
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
			const texture = new Texture(bitmap);
			texture.flipY = false;
			texture.colorSpace = SRGBColorSpace;
			texture.anisotropy = anisotropy;
			texture.minFilter = LinearMipmapLinearFilter;
			texture.onUpdate = () => bitmap.close();
			texture.needsUpdate = true;
			return texture;
		},
		dispose(texture) {
			texture.dispose();
			(texture.image as ImageBitmap | null)?.close?.();
		},
	};
}

/** Visible surface detail (ADR 0022) drawn over the base Earth with its shader, one patch per area. */
export class SurfaceTiles {
	readonly group = new Group();
	#manifest: PyramidManifest | null = null;
	#selector: TileSelector | null = null;
	#loader: TileLoader<Texture> | null = null;
	#state: SurfaceTilesStats['manifest'] = 'loading';
	#meshes = new Map<string, Drawn>();
	#black = new DataTexture(new Uint8Array(4), 1, 1);
	#frustum = new Frustum();
	#matrix = new Matrix4();
	#lastHeight = Number.NaN;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;
	#maxBytes: number;

	constructor(private readonly earth: ShaderMaterial, private readonly options: SurfaceTilesOptions) {
		this.#black.needsUpdate = true;
		this.#maxBytes = options.maxBytes;
		this.#fetchManifest(0);
	}

	get stats(): SurfaceTilesStats | null {
		return this.#loader ? { ...this.#loader.stats, manifest: this.#state } : null;
	}

	set maxBytes(bytes: number) {
		this.#maxBytes = bytes;
		if (this.#loader) this.#loader.maxBytes = bytes;
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
		const loader = new TileLoader(textureSource(this.options.root, manifest, this.options.anisotropy, this.options.fetch), {
			...DEFAULT_LOADER,
			coarsest: Math.min(...Object.keys(manifest.levels).map(Number)),
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
		this.#manifest = manifest;
		this.#loader = loader;
		this.#state = 'ready';
	}

	update(camera: PerspectiveCamera, viewHeight: number, sun: Vector3): void {
		const manifest = this.#manifest;
		const selector = this.#selector;
		const loader = this.#loader;
		if (!manifest || !selector || !loader || this.#disposed) return;
		this.#matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.#frustum.setFromProjectionMatrix(this.#matrix);
		const heightKm = (camera.position.length() / this.options.radius - 1) * RADIUS_KM;
		const hold = heightKm > this.#lastHeight * (1 + CLIMB);
		this.#lastHeight = heightKm;
		const scale = viewHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
		const selection = this.#maxBytes > 0 ? selector.select({ position: camera.position, frustum: this.#frustum, sun, scale }) : { day: [], night: [] };
		this.#draw(loader.update(selection, { hold, scale }), manifest);
	}

	#draw(patches: Patch<Texture>[], manifest: PyramidManifest) {
		const now = performance.now();
		for (const drawn of this.#meshes.values()) drawn.mesh.visible = false;
		for (const patch of patches) {
			const drawn = this.#meshes.get(patch.id) ?? this.#create(patch, manifest);
			const uniforms = drawn.material.uniforms;
			uniforms.tileDay.value = patch.day?.resource ?? this.#black;
			uniforms.tileNight.value = patch.night?.resource ?? this.#black;
			(uniforms.dayRect.value as Vector3).set(...(patch.day ? rectIn(patch.key, patch.day.key) : WHOLE));
			(uniforms.nightRect.value as Vector3).set(...(patch.night ? rectIn(patch.key, patch.night.key) : WHOLE));
			(uniforms.tileLayers.value as Vector2).set(patch.day ? 1 : 0, patch.night ? 1 : 0);
			drawn.mesh.visible = true;
			drawn.shownAt = now;
		}
		if (this.#meshes.size <= patches.length) return;
		const stale = [...this.#meshes].filter(([, d]) => !d.mesh.visible).sort((a, b) => a[1].shownAt - b[1].shownAt);
		let excess = this.#meshes.size - MAX_MESHES;
		for (const [id, drawn] of stale) {
			if (excess <= 0 && now - drawn.shownAt < MESH_KEEP_MS) break;
			this.#remove(id, drawn);
			excess--;
		}
	}

	#create(patch: Patch<Texture>, manifest: PyramidManifest): Drawn {
		const { key } = patch;
		const bounds = tileBounds(key, manifest);
		const deg = manifest.levels[key.z].degrees;
		const rad = Math.PI / 180;
		const segments = key.z >= 4 ? 8 : 16;
		const geometry = new SphereGeometry(this.options.radius, segments, segments, (bounds.west + 180) * rad, deg * rad, (90 - bounds.north) * rad, deg * rad);
		const span = manifest.tileTexels + 2 * manifest.border;
		const material = new ShaderMaterial({
			vertexShader: this.earth.vertexShader,
			fragmentShader: this.earth.fragmentShader,
			defines: { TILE: '' },
			uniforms: {
				...this.earth.uniforms,
				uvRect: { value: new Vector4((bounds.west + 180) / 360, (bounds.south + 90) / 180, deg / 360, deg / 180) },
				tileDay: { value: this.#black },
				tileNight: { value: this.#black },
				tileLayers: { value: new Vector2() },
				tileInset: { value: new Vector2(manifest.tileTexels / span, manifest.border / span) },
				tileSize: { value: span },
				dayRect: { value: new Vector3(0, 0, 1) },
				nightRect: { value: new Vector3(0, 0, 1) },
			},
			polygonOffset: true,
			polygonOffsetFactor: -1,
			polygonOffsetUnits: -4 * key.z,
		});
		const mesh = new Mesh(geometry, material);
		mesh.renderOrder = key.z;
		this.group.add(mesh);
		const drawn = { mesh, material, shownAt: 0 };
		this.#meshes.set(patch.id, drawn);
		return drawn;
	}

	#remove(id: string, { mesh, material }: Drawn) {
		mesh.geometry.dispose();
		material.dispose();
		this.group.remove(mesh);
		this.#meshes.delete(id);
	}

	clear(): void {
		this.#loader?.clear();
		for (const [id, drawn] of [...this.#meshes]) this.#remove(id, drawn);
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#retry);
		this.#loader?.dispose();
		for (const [id, drawn] of [...this.#meshes]) this.#remove(id, drawn);
		this.#black.dispose();
	}
}
