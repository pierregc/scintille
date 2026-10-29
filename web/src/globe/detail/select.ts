import { Box3, type Frustum, Vector3 } from 'three';
import { latLonToVector } from '../sun';
import {
	childrenOf,
	finestLevel,
	keyOf,
	type Layer,
	nearestPoint,
	type PyramidManifest,
	type TileBounds,
	type TileKey,
	texelKm,
	tileBounds,
} from './pyramid';

export const LAYERS: readonly Layer[] = ['day', 'night'];
export const RADIUS_KM = 6371;
const DAY_MIN_SIN = Math.sin((-21 * Math.PI) / 180);
const NIGHT_MAX_SIN = Math.sin((3 * Math.PI) / 180);

export interface SurfaceView {
	/** Camera position, globe units. */
	position: Vector3;
	frustum: Frustum;
	/** Unit vector toward the sun. */
	sun: Vector3;
	/** CSS pixels covered by 1 km seen from 1 km away: view height / (2 tan(fov / 2)). */
	scale: number;
}

export interface WantedTile {
	key: TileKey;
	id: string;
	/** From the camera to the tile's nearest point. */
	distanceKm: number;
}

export type Selection = Record<Layer, WantedTile[]>;

export interface SelectOptions {
	radius: number;
	/** Texel of the global textures under the pyramid. */
	baseTexelKm: number;
	/** Refine while a texel covers more CSS pixels than this. */
	texelPixels: number;
	/** Whether a tile of a layer exists: presence bitset, minus tiles known to be missing. */
	has(layer: Layer, key: TileKey): boolean;
}

interface Shape {
	bounds: TileBounds;
	centre: Vector3;
	angularRadius: number;
	box: Box3;
	samples: Vector3[];
}

interface Seen {
	frame: number;
	visible: boolean;
	distanceKm: number;
	minSin: number;
	maxSin: number;
}

const MAX_SHAPES = 4096;

/**
 * Tiles worth showing (ADR 0022): a tile is wanted while a texel of its parent covers more than
 * `texelPixels` CSS pixels at its nearest visible point. A parent stays wanted where one of its
 * visible children is absent or not needed, so every visible area keeps its finest useful source.
 * Day where the sun is above −21°, night where it is below 3°.
 */
export class TileSelector {
	#shapes = new Map<string, Shape>();
	#seen = new Map<string, Seen>();
	#frame = 0;
	#roots: TileKey[];
	#finest: Record<Layer, number>;

	constructor(private readonly manifest: PyramidManifest, private readonly options: SelectOptions) {
		const coarsest = Math.min(...Object.keys(manifest.levels).map(Number));
		const { columns, rows } = manifest.levels[coarsest];
		this.#roots = [];
		for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) this.#roots.push({ z: coarsest, x, y });
		this.#finest = { day: finestLevel(manifest, 'day'), night: finestLevel(manifest, 'night') };
	}

	select(view: SurfaceView): Selection {
		const selection: Selection = { day: [], night: [] };
		const { radius, baseTexelKm, texelPixels } = this.options;
		const distance = view.position.length();
		const heightKm = (distance / radius - 1) * RADIUS_KM;
		const pixels = (texel: number, distanceKm: number) => (texel * view.scale) / distanceKm;
		if (pixels(baseTexelKm, Math.max(heightKm, 1e-3)) <= texelPixels) return selection;

		this.#frame++;
		if (this.#seen.size > MAX_SHAPES) this.#seen.clear();
		const camLat = (Math.asin(view.position.y / distance) * 180) / Math.PI;
		const camLon = (Math.atan2(-view.position.z, view.position.x) * 180) / Math.PI;
		const horizon = Math.acos(Math.min(1, radius / distance));
		const direction = view.position.clone().divideScalar(distance);
		const point = new Vector3();
		const seen = (key: TileKey, id: string): Seen => {
			let s = this.#seen.get(id);
			if (s?.frame === this.#frame) return s;
			const shape = this.#shape(key, id);
			s ??= { frame: 0, visible: false, distanceKm: 0, minSin: 0, maxSin: 0 };
			s.frame = this.#frame;
			s.visible = Math.acos(Math.min(1, shape.centre.dot(direction))) <= horizon + shape.angularRadius && view.frustum.intersectsBox(shape.box);
			if (s.visible) {
				const [lat, lon] = nearestPoint(shape.bounds, camLat, camLon);
				point.set(...latLonToVector(lat, lon)).multiplyScalar(radius);
				s.distanceKm = Math.max((point.distanceTo(view.position) / radius) * RADIUS_KM, heightKm);
				s.minSin = Infinity;
				s.maxSin = -Infinity;
				for (const sample of shape.samples) {
					const sine = sample.dot(view.sun);
					s.minSin = Math.min(s.minSin, sine);
					s.maxSin = Math.max(s.maxSin, sine);
				}
			}
			this.#seen.set(id, s);
			return s;
		};

		for (const layer of LAYERS) {
			const finest = this.#finest[layer];
			if (finest < 0) continue;
			const lit = layer === 'day' ? (s: Seen) => s.maxSin > DAY_MIN_SIN : (s: Seen) => s.minSin < NIGHT_MAX_SIN;
			const out = selection[layer];
			const visit = (key: TileKey, id: string, s: Seen) => {
				const texel = texelKm(this.manifest, key.z);
				if (key.z >= finest || pixels(texel, s.distanceKm) <= texelPixels) {
					out.push({ key, id, distanceKm: s.distanceKm });
					return;
				}
				let keep = false;
				for (const child of childrenOf(key)) {
					const childId = keyOf(child);
					const c = seen(child, childId);
					if (!c.visible || !lit(c)) continue;
					if (this.options.has(layer, child) && pixels(texel, c.distanceKm) > texelPixels) visit(child, childId, c);
					else keep = true;
				}
				if (keep) out.push({ key, id, distanceKm: s.distanceKm });
			};
			for (const root of this.#roots) {
				const id = keyOf(root);
				const s = seen(root, id);
				if (s.visible && lit(s) && this.options.has(layer, root) && pixels(baseTexelKm, s.distanceKm) > texelPixels) visit(root, id, s);
			}
		}
		return selection;
	}

	#shape(key: TileKey, id: string): Shape {
		let shape = this.#shapes.get(id);
		if (shape) return shape;
		if (this.#shapes.size > MAX_SHAPES) this.#shapes.clear();
		const bounds = tileBounds(key, this.manifest);
		const deg = bounds.east - bounds.west;
		const angularRadius = (deg * Math.SQRT1_2 * Math.PI) / 180;
		const samples: Vector3[] = [];
		for (const lat of [bounds.north, (bounds.north + bounds.south) / 2, bounds.south]) {
			for (const lon of [bounds.west, (bounds.west + bounds.east) / 2, bounds.east]) samples.push(new Vector3(...latLonToVector(lat, lon)));
		}
		const radius = this.options.radius;
		const box = new Box3().setFromPoints(samples.map((p) => p.clone().multiplyScalar(radius))).expandByScalar(radius * (1 - Math.cos(angularRadius)));
		shape = { bounds, centre: new Vector3(...latLonToVector((bounds.north + bounds.south) / 2, (bounds.west + bounds.east) / 2)), angularRadius, box, samples };
		this.#shapes.set(id, shape);
		return shape;
	}
}
