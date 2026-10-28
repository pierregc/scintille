import {
	Box3,
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
import { latLonToVector } from '../sun';
import {
	KM_PER_DEG,
	keyOf,
	type Layer,
	nearestPoint,
	Presence,
	type PyramidManifest,
	type TileKey,
	tileBounds,
	texelPixels,
} from './pyramid';

export interface SurfaceTilesOptions {
	root: string;
	radius: number;
	/** Base Earth texel, km. */
	baseTexelKm: number;
	/** Refine while a texel covers more CSS pixels than this. */
	texelPixels: number;
	/** A tile is requested once wanted this long, so flights do not load what they pass through. */
	dwellMs: number;
	/** Finer tiles reuse their ancestor's night lights at this level: VIIRS pixels are 742 m. */
	nightMaxLevel: number;
	anisotropy: number;
	maxTextures: number;
	concurrency: number;
}

export interface SurfaceTilesStats {
	wanted: number;
	drawn: number;
	textures: number;
	pending: number;
	loaded: number;
	failed: number;
	deepest: number;
}

interface Entry {
	key: TileKey;
	id: string;
	textures: Partial<Record<Layer, Texture>>;
	loading: Partial<Record<Layer, AbortController>>;
	mesh?: Mesh;
	/** Where the night texture comes from when this level is finer than the night lights. */
	night?: Entry;
	used: number;
	wanted: number;
	since: number;
}

const DAY_MIN_SIN = Math.sin((-21 * Math.PI) / 180);
const NIGHT_MAX_SIN = Math.sin((3 * Math.PI) / 180);
const RADIUS_KM = 6371;

/** Visible-detail tiles drawn over the base Earth with its shader, each from its own textures. */
export class SurfaceTiles {
	readonly group = new Group();
	#manifest: PyramidManifest | null = null;
	#presence: Presence | null = null;
	#entries = new Map<string, Entry>();
	#queue: { entry: Entry; layer: Layer; priority: number }[] = [];
	#active = 0;
	#frame = 0;
	#loaded = 0;
	#failed = 0;
	#stats: SurfaceTilesStats = { wanted: 0, drawn: 0, textures: 0, pending: 0, loaded: 0, failed: 0, deepest: 0 };
	#black = new DataTexture(new Uint8Array(4), 1, 1);
	#frustum = new Frustum();
	#matrix = new Matrix4();
	#disposed = false;

	constructor(private readonly earth: ShaderMaterial, private readonly options: SurfaceTilesOptions) {
		this.#black.needsUpdate = true;
		void fetch(`${options.root}/manifest.json`)
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`manifest ${res.status}`))))
			.then((manifest: PyramidManifest) => {
				this.#manifest = manifest;
				this.#presence = new Presence(manifest);
			})
			.catch((error: unknown) => console.warn('surface tiles:', error));
	}

	get stats(): SurfaceTilesStats {
		return this.#stats;
	}

	update(camera: PerspectiveCamera, viewHeight: number, sun: Vector3): void {
		const manifest = this.#manifest;
		const presence = this.#presence;
		if (!manifest || !presence || this.#disposed) return;
		this.#frame++;
		this.#matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		this.#frustum.setFromProjectionMatrix(this.#matrix);
		const position = camera.position;
		const distance = position.length();
		const heightKm = (distance / this.options.radius - 1) * RADIUS_KM;
		const camLat = (Math.asin(position.y / distance) * 180) / Math.PI;
		const camLon = (Math.atan2(-position.z, position.x) * 180) / Math.PI;
		const horizon = Math.acos(Math.min(1, this.options.radius / distance));
		const cameraDir = position.clone().divideScalar(distance);

		const wanted: { key: TileKey; layers: Layer[]; distanceKm: number }[] = [];
		const distanceTo = (lat: number, lon: number) =>
			new Vector3(...latLonToVector(lat, lon)).multiplyScalar(this.options.radius).distanceTo(position) / this.options.radius * RADIUS_KM;
		const firstLevel = Math.min(...Object.keys(manifest.levels).map(Number));

		const visit = (key: TileKey) => {
			const bounds = tileBounds(key, manifest);
			const deg = manifest.levels[key.z].degrees;
			const centre = new Vector3(...latLonToVector((bounds.north + bounds.south) / 2, (bounds.west + bounds.east) / 2));
			const angularRadius = (deg * Math.SQRT1_2 * Math.PI) / 180;
			if (Math.acos(Math.min(1, centre.dot(cameraDir))) > horizon + angularRadius) return;
			const samples: Vector3[] = [];
			for (const lat of [bounds.north, (bounds.north + bounds.south) / 2, bounds.south]) {
				for (const lon of [bounds.west, (bounds.west + bounds.east) / 2, bounds.east]) {
					samples.push(new Vector3(...latLonToVector(lat, lon)).multiplyScalar(this.options.radius));
				}
			}
			const box = new Box3().setFromPoints(samples).expandByScalar(this.options.radius * (1 - Math.cos(angularRadius)));
			if (!this.#frustum.intersectsBox(box)) return;
			const [lat, lon] = nearestPoint(bounds, camLat, camLon);
			const distanceKm = Math.max(distanceTo(lat, lon), heightKm);
			const texelKm = (deg / manifest.tileTexels) * KM_PER_DEG;
			const pixels = texelPixels(texelKm, distanceKm, camera.fov, viewHeight);
			if (pixels > this.options.texelPixels && key.z < manifest.maxLevel && manifest.levels[key.z + 1]) {
				for (const dy of [0, 1]) for (const dx of [0, 1]) visit({ z: key.z + 1, x: key.x * 2 + dx, y: key.y * 2 + dy });
				return;
			}
			const sines = samples.map((p) => p.dot(sun) / this.options.radius);
			const layers: Layer[] = [];
			if (Math.max(...sines) > DAY_MIN_SIN && presence.has('day', key)) layers.push('day');
			if (Math.min(...sines) < NIGHT_MAX_SIN && presence.has('night', this.#nightKey(key))) layers.push('night');
			if (layers.length) wanted.push({ key, layers, distanceKm });
		};

		const base = manifest.levels[firstLevel];
		for (let y = 0; y < base.rows; y++) {
			for (let x = 0; x < base.columns; x++) {
				const bounds = tileBounds({ z: firstLevel, x, y }, manifest);
				const [lat, lon] = nearestPoint(bounds, camLat, camLon);
				const pixels = texelPixels(this.options.baseTexelKm, Math.max(distanceTo(lat, lon), heightKm), camera.fov, viewHeight);
				if (pixels > this.options.texelPixels) visit({ z: firstLevel, x, y });
			}
		}

		const draw = new Set<Entry>();
		let deepest = 0;
		const now = performance.now();
		for (const { key, layers, distanceKm } of wanted) {
			const entry = this.#entry(key);
			if (entry.wanted !== this.#frame - 1) entry.since = now;
			entry.wanted = this.#frame;
			entry.used = this.#frame;
			const nightKey = this.#nightKey(key);
			entry.night = nightKey === key ? undefined : this.#entry(nightKey);
			if (entry.night) {
				if (entry.night.wanted !== this.#frame) entry.night.since = Math.min(entry.night.wanted === this.#frame - 1 ? entry.night.since : now, entry.since);
				entry.night.wanted = this.#frame;
				entry.night.used = this.#frame;
			}
			const source = (layer: Layer) => (layer === 'night' && entry.night ? entry.night : entry);
			for (const layer of layers) {
				const from = source(layer);
				if (!from.textures[layer] && !from.loading[layer] && now - entry.since >= this.options.dwellMs) this.#enqueue(from, layer, key.z * 1e6 - distanceKm);
			}
			if (layers.every((layer) => source(layer).textures[layer])) {
				draw.add(entry);
				deepest = Math.max(deepest, key.z);
				continue;
			}
			for (let z = key.z - 1; z >= firstLevel; z--) {
				const shift = key.z - z;
				const parent = this.#entries.get(keyOf({ z, x: key.x >> shift, y: key.y >> shift }));
				if (parent && Object.keys(parent.textures).length) {
					parent.used = this.#frame;
					draw.add(parent);
					break;
				}
			}
		}
		for (const entry of this.#entries.values()) if (entry.mesh) entry.mesh.visible = draw.has(entry);
		for (const entry of draw) this.#show(entry, manifest);
		this.#pump();
		this.#evict();
		let textures = 0;
		for (const entry of this.#entries.values()) textures += Object.keys(entry.textures).length;
		this.#stats = { wanted: wanted.length, drawn: draw.size, textures, pending: this.#queue.length + this.#active, loaded: this.#loaded, failed: this.#failed, deepest };
	}

	#nightKey(key: TileKey): TileKey {
		const shift = key.z - this.options.nightMaxLevel;
		return shift > 0 ? { z: this.options.nightMaxLevel, x: key.x >> shift, y: key.y >> shift } : key;
	}

	#entry(key: TileKey): Entry {
		const id = keyOf(key);
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = { key, id, textures: {}, loading: {}, used: this.#frame, wanted: -1, since: 0 };
			this.#entries.set(id, entry);
		}
		return entry;
	}

	#enqueue(entry: Entry, layer: Layer, priority: number) {
		if (this.#queue.some((q) => q.entry === entry && q.layer === layer)) return;
		this.#queue.push({ entry, layer, priority });
	}

	#pump() {
		for (const entry of this.#entries.values()) {
			if (entry.wanted < this.#frame - 30) for (const controller of Object.values(entry.loading)) controller?.abort();
		}
		this.#queue = this.#queue.filter((q) => q.entry.wanted === this.#frame);
		this.#queue.sort((a, b) => a.priority - b.priority);
		while (this.#active < this.options.concurrency) {
			const next = this.#queue.shift();
			if (!next) break;
			const { entry, layer } = next;
			const controller = new AbortController();
			entry.loading[layer] = controller;
			this.#active++;
			void this.#load(entry, layer, controller.signal).finally(() => {
				this.#active--;
				entry.loading[layer] = undefined;
			});
		}
	}

	async #load(entry: Entry, layer: Layer, signal: AbortSignal) {
		try {
			const res = await fetch(`${this.options.root}/${layer}/${entry.key.z}/${entry.key.x}-${entry.key.y}.webp`, { signal });
			if (!res.ok) throw new Error(`${res.status}`);
			const bitmap = await createImageBitmap(await res.blob(), {
				imageOrientation: 'flipY',
				premultiplyAlpha: 'none',
				colorSpaceConversion: 'none',
			});
			if (this.#disposed || !this.#entries.has(entry.id)) return bitmap.close();
			const texture = new Texture(bitmap);
			texture.flipY = false;
			texture.colorSpace = SRGBColorSpace;
			texture.anisotropy = this.options.anisotropy;
			texture.minFilter = LinearMipmapLinearFilter;
			texture.needsUpdate = true;
			entry.textures[layer] = texture;
			this.#loaded++;
		} catch (error) {
			if (!signal.aborted) {
				this.#failed++;
				console.warn('surface tile', entry.id, layer, error);
			}
		}
	}

	#show(entry: Entry, manifest: PyramidManifest) {
		const mesh = entry.mesh ?? this.#create(entry, manifest);
		const material = mesh.material as ShaderMaterial;
		material.uniforms.tileDay.value = entry.textures.day ?? this.#black;
		const night = (entry.night ?? entry).textures.night;
		material.uniforms.tileNight.value = night ?? this.#black;
		(material.uniforms.tileLayers.value as Vector2).set(entry.textures.day ? 1 : 0, night ? 1 : 0);
		mesh.visible = true;
	}

	#create(entry: Entry, manifest: PyramidManifest): Mesh {
		const bounds = tileBounds(entry.key, manifest);
		const deg = manifest.levels[entry.key.z].degrees;
		const rad = Math.PI / 180;
		const segments = entry.key.z >= 4 ? 8 : 16;
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
				nightRect: { value: this.#nightRect(entry.key) },
			},
			polygonOffset: true,
			polygonOffsetFactor: -1,
			polygonOffsetUnits: -4 * entry.key.z,
		});
		const mesh = new Mesh(geometry, material);
		mesh.renderOrder = entry.key.z;
		this.group.add(mesh);
		entry.mesh = mesh;
		return mesh;
	}

	/** Offset and scale of a tile inside its night ancestor, in texture coordinates (v up). */
	#nightRect({ z, x, y }: TileKey): Vector3 {
		const shift = Math.max(0, z - this.options.nightMaxLevel);
		const n = 2 ** shift;
		return new Vector3((x % n) / n, (n - 1 - (y % n)) / n, 1 / n);
	}

	#evict() {
		let count = 0;
		for (const entry of this.#entries.values()) count += Object.keys(entry.textures).length;
		if (count <= this.options.maxTextures) {
			for (const entry of this.#entries.values()) {
				if (!Object.keys(entry.textures).length && !Object.values(entry.loading).some(Boolean) && entry.used !== this.#frame) this.#drop(entry);
			}
			return;
		}
		const old = [...this.#entries.values()].filter((e) => e.used !== this.#frame).sort((a, b) => a.used - b.used);
		for (const entry of old) {
			if (count <= this.options.maxTextures) break;
			count -= Object.keys(entry.textures).length;
			this.#drop(entry);
		}
	}

	#drop(entry: Entry) {
		for (const controller of Object.values(entry.loading)) controller?.abort();
		for (const texture of Object.values(entry.textures)) texture?.dispose();
		if (entry.mesh) {
			entry.mesh.geometry.dispose();
			(entry.mesh.material as ShaderMaterial).dispose();
			this.group.remove(entry.mesh);
		}
		this.#entries.delete(entry.id);
	}

	clear() {
		for (const entry of [...this.#entries.values()]) this.#drop(entry);
		this.#queue = [];
	}

	dispose() {
		this.#disposed = true;
		this.clear();
		this.#black.dispose();
	}
}
