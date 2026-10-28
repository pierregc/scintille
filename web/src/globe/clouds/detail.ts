import {
	type Camera,
	DataArrayTexture,
	DataTexture,
	LinearFilter,
	type Matrix4,
	NearestFilter,
	RedFormat,
	RGBAFormat,
	UnsignedByteType,
	Vector2,
	Vector3,
	type WebGLRenderer,
} from 'three';
import { CLOUD_ARCHIVE_RULES as RULES } from '../../contract/cloud-archive';
import { boundedBody } from './response';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** Finer tiles of one frame, as published next to its global texture (ADR 0023). */
export interface CloudDetailRef {
	path: string;
	tile_size: number;
	border: number;
	levels: number[];
	max_latitude: number;
	fine: string;
	index_bytes: number;
}

export interface DetailSource {
	/** Absolute URL of the frame's tile pack: an index of (offset, length) pairs, then the tiles. */
	url: string;
	tileSize: number;
	border: number;
	levels: readonly number[];
	maxLatitude: number;
	/** Finest level tiles present, one bit each, row-major from the north-west. */
	fine: Uint8Array;
}

export interface TileKey {
	z: number;
	x: number;
	y: number;
}

/** Checks a manifest's detail block against the shared contract; null when absent or unusable. */
export function detailSource(ref: unknown, manifestUrl: string): DetailSource | null {
	if (typeof ref !== 'object' || ref === null) return null;
	const r = ref as Partial<CloudDetailRef>;
	const levels = RULES.detail_levels;
	if (typeof r.path !== 'string' || !r.path.endsWith('.tiles') ||
		r.tile_size !== RULES.detail_tile_size || r.border !== RULES.detail_border ||
		!Array.isArray(r.levels) || r.levels.join() !== levels.join() ||
		typeof r.max_latitude !== 'number' || typeof r.fine !== 'string' ||
		r.index_bytes !== indexSlots(levels) * 8) return null;
	let fine: Uint8Array;
	try { fine = Uint8Array.from(atob(r.fine), (c) => c.charCodeAt(0)); }
	catch { return null; }
	const finest = levels[levels.length - 1];
	if (fine.length !== Math.ceil((columns(finest) * rows(finest)) / 8)) return null;
	const url = new URL(r.path, manifestUrl).href;
	return { url, tileSize: r.tile_size, border: r.border, levels, maxLatitude: r.max_latitude, fine };
}

const indexSlots = (levels: readonly number[]) => levels.reduce((n, z) => n + rows(z) * columns(z), 0);

/** Position of a tile in a pack's index: levels in order, then rows, then columns. */
export function indexSlot(levels: readonly number[], { z, x, y }: TileKey): number {
	return indexSlots(levels.filter((level) => level < z)) + y * columns(z) + x;
}

export const columns = (z: number) => 2 ** (z + 1);
export const rows = (z: number) => 2 ** z;

/** Degrees covered by one texel of level `z`. */
export const texelDegrees = (z: number, tileSize: number) => 180 / (2 ** z * tileSize);

export function hasTile(source: DetailSource, { z, x, y }: TileKey): boolean {
	if (x < 0 || x >= columns(z) || y < 0 || y >= rows(z)) return false;
	const finest = source.levels[source.levels.length - 1];
	if (z === finest) {
		const bit = y * columns(z) + x;
		return (source.fine[bit >> 3] & (1 << (bit & 7))) !== 0;
	}
	if (!source.levels.includes(z)) return false;
	const north = 90 - (y * 180) / 2 ** z;
	const south = north - 180 / 2 ** z;
	return south < source.maxLatitude && north > -source.maxLatitude;
}


/** Texel size (km, north-south) of the global frame texture. */
export const GLOBAL_TEXEL_KM = (360 / 4096) * DEG * EARTH_RADIUS_KM;
/** A level is fine enough once its texels cover at most this many CSS pixels. */
export const TEXEL_PX = 2;

/** Level to show where one CSS pixel covers `kmPerPx` km: null while the global texture is enough. */
export function levelFor(source: DetailSource, kmPerPx: number): number | null {
	if (GLOBAL_TEXEL_KM <= TEXEL_PX * kmPerPx) return null;
	for (const z of source.levels) {
		if (texelDegrees(z, source.tileSize) * DEG * EARTH_RADIUS_KM <= TEXEL_PX * kmPerPx) return z;
	}
	return source.levels[source.levels.length - 1];
}

export interface ViewPoint {
	lat: number;
	lon: number;
	/** Km covered by one CSS pixel there. */
	kmPerPx: number;
	/** 0 at the centre of the screen, 1 at its corners. */
	offCentre: number;
}

/**
 * Tiles to show for the sampled points of a view, each with its available ancestors, finest last
 * within a point and nearest the centre first: the order to load them in.
 */
export function wantedTiles(source: DetailSource, points: readonly ViewPoint[]): TileKey[] {
	const scored = new Map<string, { key: TileKey; score: number }>();
	for (const point of points) {
		const level = levelFor(source, point.kmPerPx);
		if (level === null) continue;
		for (const z of source.levels) {
			if (z > level) break;
			const key = tileAt(point.lat, point.lon, z);
			if (!hasTile(source, key)) continue;
			const id = keyId(key);
			const score = z * 10 + point.offCentre;
			const known = scored.get(id);
			if (!known || score < known.score) scored.set(id, { key, score });
		}
	}
	return [...scored.values()].sort((a, b) => a.score - b.score).map((s) => s.key);
}

export function tileAt(lat: number, lon: number, z: number): TileKey {
	const x = Math.floor((((lon + 180) % 360) + 360) % 360 / 360 * columns(z));
	const y = Math.floor(((90 - lat) / 180) * rows(z));
	return { z, x: Math.min(x, columns(z) - 1), y: Math.min(Math.max(y, 0), rows(z) - 1) };
}

export const keyId = ({ z, x, y }: TileKey) => `${z}/${y}/${x}`;

const SAMPLES_X = 12;
const SAMPLES_Y = 8;
const ray = new Vector3();
const origin = new Vector3();
const hit = new Vector3();

/**
 * Points where rays through a grid of screen positions meet the cloud shell, in the shell's local
 * frame (`inverseWorld`), with the ground distance each CSS pixel covers there.
 */
export function viewPoints(camera: Camera & { fov: number }, inverseWorld: Matrix4, shellRadius: number,
	heightPx: number, kmPerUnit = EARTH_RADIUS_KM): ViewPoint[] {
	const points: ViewPoint[] = [];
	const pxAngle = (2 * Math.tan((camera.fov * DEG) / 2)) / heightPx;
	origin.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverseWorld);
	for (let j = 0; j <= SAMPLES_Y; j++) {
		for (let i = 0; i <= SAMPLES_X; i++) {
			const nx = (i / SAMPLES_X) * 2 - 1;
			const ny = (j / SAMPLES_Y) * 2 - 1;
			ray.set(nx, ny, 0.5).unproject(camera).applyMatrix4(inverseWorld).sub(origin).normalize();
			const distance = sphereHit(origin, ray, shellRadius);
			if (distance === null) continue;
			hit.copy(ray).multiplyScalar(distance).add(origin).normalize();
			points.push({
				lat: Math.asin(hit.y) / DEG,
				lon: Math.atan2(-hit.z, hit.x) / DEG,
				kmPerPx: distance * kmPerUnit * pxAngle,
				offCentre: Math.hypot(nx, ny) / Math.SQRT2,
			});
		}
	}
	return points;
}

function sphereHit(from: Vector3, direction: Vector3, radius: number): number | null {
	const b = from.dot(direction);
	const c = from.lengthSq() - radius * radius;
	const disc = b * b - c;
	if (disc < 0) return null;
	const t = -b - Math.sqrt(disc);
	return t > 0 ? t : null;
}

/** GPU side: a texture array of tiles, a page table per blended frame, and the loads behind them. */
export interface CloudDetail {
	readonly uniforms: Record<string, { value: unknown }>;
	/** Tiles to load and pages to show for the blended frames, from the camera. */
	update(view: DetailView): void;
	/** Resolves when no tile load is pending. */
	idle(): Promise<void>;
	dispose(): void;
}

export interface DetailView {
	camera: Camera & { fov: number };
	/** Inverse world matrix of the cloud shell. */
	inverseWorld: Matrix4;
	shellRadius: number;
	/** Km per world unit. */
	kmPerUnit: number;
	heightPx: number;
	/** Detail of the two blended frames; null when a frame has none. */
	frames: readonly [DetailSource | null, DetailSource | null];
	/** Milliseconds, for fades. */
	now: number;
}

export interface CloudDetailOptions {
	slots?: number;
	maxLoads?: number;
	fadeMs?: number;
	fetch?: typeof fetch;
	/** One byte per texel, rows from the north. */
	decode?: (blob: Blob, size: number) => Promise<Uint8Array>;
}

/** The red channel of a decoded tile image. */
export async function decodeTile(blob: Blob, size: number): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = typeof OffscreenCanvas === 'function'
			? new OffscreenCanvas(size, size)
			: Object.assign(document.createElement('canvas'), { width: size, height: size });
		const context = canvas.getContext('2d', { willReadFrequently: true }) as
			OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
		if (!context) throw new Error('no 2d context');
		context.drawImage(bitmap, 0, 0);
		const rgba = context.getImageData(0, 0, size, size).data;
		const red = new Uint8Array(size * size);
		for (let i = 0; i < red.length; i++) red[i] = rgba[i * 4];
		return red;
	} finally {
		bitmap.close();
	}
}

interface Slot {
	id: string;
	key: TileKey;
	readyAt: number;
	usedAt: number;
}

/** Page texels per finest cell: the tile shown, then the one it fades in from. */
const PAGE_TEXELS = 2;

export function createCloudDetail(
	renderer: Pick<WebGLRenderer, 'copyTextureToTexture' | 'initTexture'>,
	{
		slots: slotCount = 48,
		maxLoads = 6,
		fadeMs = 400,
		fetch: fetchTile = (input, init) => fetch(input, init),
		decode = decodeTile,
	}: CloudDetailOptions = {},
): CloudDetail {
	const size = RULES.detail_tile_size + 2 * RULES.detail_border;
	const levels = RULES.detail_levels;
	const finest = levels[levels.length - 1];
	const tiles = new DataArrayTexture(new Uint8Array(size * size * slotCount), size, size, slotCount);
	tiles.format = RedFormat;
	tiles.type = UnsignedByteType;
	tiles.minFilter = LinearFilter;
	tiles.magFilter = LinearFilter;
	tiles.generateMipmaps = false;
	tiles.flipY = false;
	tiles.unpackAlignment = 1;
	tiles.needsUpdate = true;
	renderer.initTexture(tiles);
	// Allocated on the GPU; tiles arrive layer by layer, so the zeros need not stay in memory.
	tiles.image.data = null;
	const pageData = [0, 1].map(() => new Uint8Array(columns(finest) * PAGE_TEXELS * rows(finest) * 4));
	const pages = pageData.map((data) => {
		const texture = new DataTexture(data, columns(finest) * PAGE_TEXELS, rows(finest), RGBAFormat, UnsignedByteType);
		texture.minFilter = NearestFilter;
		texture.magFilter = NearestFilter;
		texture.generateMipmaps = false;
		texture.needsUpdate = true;
		return texture;
	});
	const slots: (Slot | null)[] = Array.from({ length: slotCount }, () => null);
	const bySlot = new Map<string, number>();
	const loading = new Map<string, AbortController>();
	const failed = new Map<string, number>();
	let pending: Promise<void>[] = [];
	const fading = [true, true];
	let shown: [string, string] = ['', ''];
	let frames: readonly [DetailSource | null, DetailSource | null] = [null, null];
	let disposed = false;

	const uniforms = {
		detailTiles: { value: tiles },
		detailPagesA: { value: pages[0] },
		detailPagesB: { value: pages[1] },
		detailGrid: { value: new Vector2(RULES.detail_tile_size, RULES.detail_border) },
		detailCells: { value: new Vector2(columns(finest), rows(finest)) },
		detailOn: { value: 0 },
	};

	const tileId = (source: DetailSource, key: TileKey) => `${source.url}|${keyId(key)}`;
	const indexes = new Map<string, Promise<Uint32Array>>();

	/** Byte range of one request; a server that ignores ranges would send the whole pack. */
	const readRange = async (url: string, start: number, length: number, signal: AbortSignal) => {
		const response = await fetchTile(url, { signal, headers: { Range: `bytes=${start}-${start + length - 1}` } });
		if (response.status !== 206) {
			await response.body?.cancel();
			throw new Error(`cloud tiles ${response.status}`);
		}
		return boundedBody(response, Math.min(length, RULES.max_frame_bytes));
	};

	const indexOf = (source: DetailSource): Promise<Uint32Array> => {
		let index = indexes.get(source.url);
		if (!index) {
			const bytes = indexSlots(levels) * 8;
			index = readRange(source.url, 0, bytes, new AbortController().signal)
				.then((data) => new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4));
			index.catch(() => indexes.delete(source.url));
			indexes.set(source.url, index);
			if (indexes.size > 4) indexes.delete(indexes.keys().next().value as string);
		}
		return index;
	};

	const freeSlot = (keep: Set<string>): number => {
		let best = -1;
		for (let i = 0; i < slots.length; i++) {
			const slot = slots[i];
			if (!slot) return i;
			if (keep.has(slot.id)) continue;
			if (best < 0 || slot.usedAt < (slots[best]?.usedAt ?? Infinity)) best = i;
		}
		if (best >= 0) {
			const old = slots[best];
			if (old) bySlot.delete(old.id);
			slots[best] = null;
		}
		return best;
	};

	const load = (source: DetailSource, key: TileKey, keep: Set<string>, now: number) => {
		const id = tileId(source, key);
		const request = new AbortController();
		loading.set(id, request);
		const work = (async () => {
			try {
				const index = await indexOf(source);
				const slot = indexSlot(levels, key);
				const [offset, length] = [index[2 * slot], index[2 * slot + 1]];
				if (!length) throw new Error('cloud tile missing from its pack');
				const bytes = await readRange(source.url, offset, length, request.signal);
				const texels = await decode(new Blob([bytes], { type: 'image/webp' }), size);
				if (request.signal.aborted || disposed || texels.length !== size * size) return;
				const free = freeSlot(keep);
				if (free < 0) return;
				const layer = new DataTexture(texels, size, size, RedFormat, UnsignedByteType);
				layer.unpackAlignment = 1;
				renderer.copyTextureToTexture(layer, tiles, null, new Vector3(0, 0, free));
				slots[free] = { id, key, readyAt: performance.now(), usedAt: now };
				bySlot.set(id, free);
				// The slot may have held a tile the pages still point to.
				refreshPages();
			} catch {
				if (!request.signal.aborted) failed.set(id, now + 30_000);
			} finally {
				loading.delete(id);
			}
		})();
		pending.push(work);
		void work.finally(() => { pending = pending.filter((p) => p !== work); });
	};

	const writePages = (frame: 0 | 1, source: DetailSource | null, now: number): boolean => {
		const data = pageData[frame];
		data.fill(0);
		if (!source) return false;
		let stillFading = false;
		const cols = columns(finest);
		const cell = { z: finest, x: 0, y: 0 };
		const loaded: { slot: number; z: number; fade: number }[] = [];
		for (let y = 0; y < rows(finest); y++) {
			for (let x = 0; x < cols; x++) {
				cell.x = x;
				cell.y = y;
				loaded.length = 0;
				for (let i = levels.length - 1; i >= 0 && loaded.length < 2; i--) {
					const z = levels[i];
					const shift = finest - z;
					const index = bySlot.get(tileId(source, { z, x: x >> shift, y: y >> shift }));
					if (index === undefined) continue;
					const slot = slots[index];
					if (!slot) continue;
					const fade = Math.min(Math.max((now - slot.readyAt) / fadeMs, 0), 1);
					loaded.push({ slot: index, z, fade });
				}
				if (loaded.length === 0) continue;
				const offset = (y * cols + x) * PAGE_TEXELS * 4;
				const [top, under] = loaded;
				data[offset] = top.slot;
				data[offset + 1] = top.z;
				data[offset + 2] = Math.round(top.fade * 255);
				data[offset + 3] = 255;
				if (top.fade < 1) stillFading = true;
				if (under) {
					data[offset + 4] = under.slot;
					data[offset + 5] = under.z;
					data[offset + 6] = 255;
					data[offset + 7] = 255;
				}
			}
		}
		return stillFading;
	};

	const refreshPages = () => {
		const now = performance.now();
		for (const frame of [0, 1] as const) {
			fading[frame] = writePages(frame, frames[frame], now);
			pages[frame].needsUpdate = true;
		}
	};

	return {
		uniforms,
		update(view) {
			if (disposed) return;
			const now = performance.now();
			frames = view.frames;
			const points = viewPoints(view.camera, view.inverseWorld, view.shellRadius, view.heightPx, view.kmPerUnit);
			const keep = new Set<string>();
			const queue: [DetailSource, TileKey][] = [];
			for (const source of view.frames) {
				if (!source) continue;
				for (const key of wantedTiles(source, points)) {
					if (keep.size >= slotCount - 4) break;
					const id = tileId(source, key);
					if (keep.has(id)) continue;
					keep.add(id);
					const index = bySlot.get(id);
					const slot = index === undefined ? null : slots[index];
					if (slot) slot.usedAt = now;
					else if (!loading.has(id) && (failed.get(id) ?? 0) <= now) queue.push([source, key]);
				}
			}
			for (const [id, request] of loading) if (!keep.has(id)) request.abort();
			for (const [source, key] of queue) {
				if (loading.size >= maxLoads) break;
				load(source, key, keep, now);
			}
			const ids: [string, string] = [view.frames[0]?.url ?? '', view.frames[1]?.url ?? ''];
			for (const frame of [0, 1] as const) {
				if (!fading[frame] && ids[frame] === shown[frame]) continue;
				fading[frame] = writePages(frame, view.frames[frame], performance.now());
				pages[frame].needsUpdate = true;
			}
			shown = ids;
			uniforms.detailOn.value = bySlot.size > 0 && (view.frames[0] || view.frames[1]) ? 1 : 0;
		},
		async idle() {
			while (pending.length > 0) await Promise.allSettled(pending);
		},
		dispose() {
			disposed = true;
			for (const request of loading.values()) request.abort();
			tiles.dispose();
			for (const page of pages) page.dispose();
		},
	};
}
