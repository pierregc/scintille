import { CHANNEL } from './channel';
import { type FlashKind, isGround } from './kind';

/**
 * Floats per channel segment: start xyz, width (CSS px), end xyz, light, path arrival at start and end, level, cloud flag.
 * Level: 0 the main channel, 1 to 3 branches by depth, 4 a second ground contact path (ADR 0033; #401 writes it, #402 lights it from a later stroke).
 * Cloud flag: 0 clear air (crisp, with a halo), 1 in the cloud (veiled by depth), 2 a trace in the cloud (crisp, at least 30 % of its light; #401).
 * The shaders read the flag as in-cloud above 0.5, so 1 and 2 draw alike until #401.
 */
export const SEGMENT_FLOATS = 12;
export const MAX_SEGMENTS = 256;

/** Silhouettes a flash can take; drawn from its seed, never observed. */
export type Look = 'filament' | 'branching' | 'fork' | 'network' | 'strikes';

export interface Skeleton {
	look: Look;
	kind: FlashKind;
	/** Segments written in `data`. */
	count: number;
	data: Float32Array;
}

/** Shape choices, in km and CSS px; see docs/flash-profile.md. */
export const SKELETON = {
	/** In-cloud leaders run at these heights, km; ground channels leave the cloud below `cloudBaseKm`. */
	cloudBottomKm: 8,
	cloudTopKm: 11.5,
	cloudBaseKm: 7,
	/** Core width of a main channel, CSS px, and of the finest filaments. */
	trunkWidth: 1.6,
	minWidth: 0.35,
	/** Shortest segment over the flash extent: the finest detail of a main path; branches are drawn coarser. */
	detail: 1 / 48,
	/** Lateral offset of a midpoint over its segment length, at the coarsest level, then per level. */
	roughness: [0.18, 0.34],
	roughnessDecay: 0.88,
} as const;

type Vec = [number, number, number];

/** Deterministic generator in [0, 1). */
function random(seed: number): () => number {
	let s = Math.floor(seed * 4294967296) >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const length = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface Path {
	points: Vec[];
	/** Path length from the flash origin at each point, km. */
	from: number[];
}

interface Style {
	rng: () => number;
	/** Horizontal paths stay between the cloud heights; vertical ones keep their own course. */
	minLength: number;
	tortuosity: number;
}

/** Unit vector at right angles to `d`, random around it; flattened toward the horizontal for in-cloud paths. */
function across(d: Vec, rng: () => number, horizontal: boolean): Vec {
	const n = length(d) || 1;
	const u: Vec = [d[0] / n, d[1] / n, d[2] / n];
	const ref: Vec = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	const a: Vec = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]];
	const an = length(a);
	const p: Vec = [a[0] / an, a[1] / an, a[2] / an];
	const q: Vec = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
	const angle = rng() * 2 * Math.PI;
	const v: Vec = add([p[0] * Math.cos(angle), p[1] * Math.cos(angle), p[2] * Math.cos(angle)], q, Math.sin(angle));
	if (horizontal) v[2] *= 0.3;
	return v;
}

const gauss = (rng: () => number): number => (rng() + rng() + rng() - 1.5) * 1.15;

/**
 * A path from `a` to `b` with deviations at three scales: one or two broad bends (an elbow or an S),
 * then midpoints displaced sideways at uneven places, less at each finer level.
 */
function wander(style: Style, a: Vec, b: Vec, horizontal: boolean, bends: number): Vec[] {
	const { rng } = style;
	const span = sub(b, a);
	const total = length(span);
	const anchors: Vec[] = [a];
	let side = rng() < 0.5 ? -1 : 1;
	for (let k = 1; k <= bends; k++) {
		const t = (k - 0.35 + rng() * 0.7) / (bends + 1);
		const swing = across(span, rng, horizontal);
		const amount = total * (0.08 + 0.22 * rng()) * style.tortuosity * side;
		anchors.push(add(lerp(a, b, t), swing, amount));
		// Two bends on opposite sides make an S, on the same side a broad curve.
		if (rng() < 0.7) side = -side;
	}
	anchors.push(b);
	const points: Vec[] = [a];
	const split = (p: Vec, q: Vec, rough: number) => {
		const d = sub(q, p);
		const l = length(d);
		if (l <= style.minLength) {
			points.push(q);
			return;
		}
		const m = add(lerp(p, q, 0.5 + (rng() - 0.5) * 0.4), across(d, rng, horizontal), l * rough * gauss(rng));
		split(p, m, rough * SKELETON.roughnessDecay);
		split(m, q, rough * SKELETON.roughnessDecay);
	};
	const rough = (SKELETON.roughness[0] + (SKELETON.roughness[1] - SKELETON.roughness[0]) * rng()) * style.tortuosity;
	for (let k = 1; k < anchors.length; k++) split(anchors[k - 1], anchors[k], rough);
	return points;
}

/** Writes segments, keeping within `MAX_SEGMENTS`; returns false once full. */
class Writer {
	readonly data = new Float32Array(MAX_SEGMENTS * SEGMENT_FLOATS);
	count = 0;
	/** Path length the arrival is first measured against, km. */
	extent = 1;

	path(points: Vec[], from: number, width: [number, number], light: [number, number], level: number): Path {
		const out: Path = { points: [points[0]], from: [from] };
		let along = from;
		for (let k = 1; k < points.length; k++) {
			if (this.count >= MAX_SEGMENTS) break;
			const a = points[k - 1];
			const b = points[k];
			const l = length(sub(b, a));
			const t = (k - 0.5) / (points.length - 1);
			const o = this.count * SEGMENT_FLOATS;
			this.data.set(a, o);
			this.data[o + 3] = Math.max(SKELETON.minWidth, width[0] + (width[1] - width[0]) * t);
			this.data.set(b, o + 4);
			this.data[o + 7] = light[0] + (light[1] - light[0]) * t;
			this.data[o + 8] = along / this.extent;
			along += l;
			this.data[o + 9] = along / this.extent;
			this.data[o + 10] = level;
			this.data[o + 11] = Math.max(a[2], b[2]) > SKELETON.cloudBaseKm ? 1 : 0;
			this.count++;
			out.points.push(b);
			out.from.push(along);
		}
		return out;
	}
}

const clampHeight = (p: Vec): Vec => [p[0], p[1], Math.min(SKELETON.cloudTopKm, Math.max(SKELETON.cloudBottomKm, p[2]))];

/** Branches off `parent` at uneven places, most of them on one side, each possibly branching again. */
function branch(w: Writer, style: Style, parent: Path, count: number, level: number, reach: number, width: number, light: number, horizontal: boolean, down: boolean): void {
	const { rng } = style;
	const favoured = rng() < 0.5 ? -1 : 1;
	const lean = 0.65 + 0.3 * rng();
	const n = parent.points.length;
	for (let k = 0; k < count && w.count < MAX_SEGMENTS - 2 && n > 3; k++) {
		const i = Math.min(n - 2, 1 + Math.floor((0.06 + 0.84 * rng()) * (n - 2)));
		const start = parent.points[i];
		const tangent = sub(parent.points[i + 1], parent.points[i - 1]);
		const side = rng() < lean ? favoured : -favoured;
		// Most branches leave at 20 to 70 degrees, a few almost square.
		const angle = (rng() < 0.85 ? 0.35 + 0.85 * rng() : 1.3 + 0.3 * rng()) * side;
		const tl = length(tangent) || 1;
		const t: Vec = [tangent[0] / tl, tangent[1] / tl, tangent[2] / tl];
		let dir: Vec;
		if (horizontal) {
			const c = Math.cos(angle);
			const s = Math.sin(angle);
			dir = [t[0] * c - t[1] * s, t[0] * s + t[1] * c, (rng() - 0.5) * 0.15];
		} else {
			const out = across(t, rng, false);
			dir = add([t[0] * Math.cos(angle), t[1] * Math.cos(angle), t[2] * Math.cos(angle)], out, Math.abs(Math.sin(angle)));
			if (down) dir[2] = -Math.abs(dir[2]) - 0.35;
		}
		const dl = length(dir) || 1;
		const size = reach * (rng() < 0.2 ? 0.55 + 0.45 * rng() : 0.15 + 0.4 * rng());
		let end = add(start, [dir[0] / dl, dir[1] / dl, dir[2] / dl], size);
		if (horizontal) end = clampHeight(end);
		else end[2] = Math.max(end[2], 0.3 + 2 * rng());
		const coarse: Style = { ...style, minLength: style.minLength * (level === 1 ? 1.4 : 2) };
		let points = wander(coarse, start, end, horizontal, rng() < 0.4 ? 1 : 0);
		if (horizontal) points = points.map(clampHeight);
		else points = points.map((p) => [p[0], p[1], Math.max(0.2, p[2])] as Vec);
		const strong = rng() < 0.15 ? 1 : 0.55 + 0.35 * rng();
		const b = w.path(points, parent.from[i], [width, width * 0.45], [light * strong, light * strong * 0.3], level);
		if (level < 3) {
			const spurs = rng() < 0.45 ? 0 : Math.floor(rng() * (level === 1 ? 4 : 2));
			branch(w, style, b, spurs, level + 1, size * 0.6, width * 0.6, light * 0.6, horizontal, down);
		}
	}
}

/**
 * Procedural channel of a flash of observed radius `radiusKm`, in km east, north and up from its
 * position. Its silhouette, branches and heights are drawn from `seed`: the satellites only see the
 * light, so none of this is observed.
 */
export function channelSkeleton(seed: number, radiusKm: number, kind: FlashKind): Skeleton {
	const ground = isGround(kind);
	const rng = random(seed);
	const r = Math.max(3, radiusKm);
	const pick = rng();
	const look: Look = ground
		? pick < 0.3 ? 'filament' : pick < 0.7 ? 'branching' : pick < 0.9 ? 'fork' : 'strikes'
		: pick < 0.2 ? 'filament' : pick < 0.5 ? 'branching' : 'network';
	const w = new Writer();
	const tortuosity = 0.8 + 0.7 * rng();
	const widthScale = 0.85 + 0.4 * rng();
	const trunk = SKELETON.trunkWidth * widthScale;
	const origin: Vec = [(rng() - 0.5) * 0.6 * r, (rng() - 0.5) * 0.6 * r, 9.5 + rng()];
	const heading = rng() * 2 * Math.PI;

	if (ground) {
		// In the cloud, a short leader feeds the channel that drops to the ground.
		const feed = (0.2 + 0.6 * rng()) * r;
		const top: Vec = clampHeight([origin[0] + Math.cos(heading) * feed, origin[1] + Math.sin(heading) * feed, origin[2] - 0.5 * rng()]);
		const drift = (0.15 + 0.35 * rng()) * CHANNEL.lengthScale * Math.min(r, 8);
		const toward = heading + (rng() - 0.5) * 2;
		const strike: Vec = [top[0] + Math.cos(toward) * drift, top[1] + Math.sin(toward) * drift, 0];
		w.extent = feed + length(sub(strike, top)) * 1.3;
		const style: Style = { rng, minLength: w.extent * SKELETON.detail, tortuosity };
		const leader = w.path(wander(style, origin, top, true, 1).map(clampHeight), 0, [trunk * 0.8, trunk], [0.7, 1], 0);
		const drop = wander(style, top, strike, false, rng() < 0.6 ? 2 : 1).map((p) => [p[0], p[1], Math.max(0, p[2])] as Vec);
		const descent = w.path(drop, leader.from.at(-1) ?? 0, [trunk, trunk], [1, 1], 0);
		const fork = look === 'fork' || look === 'strikes';
		if (fork) {
			const i = Math.floor(descent.points.length * (0.2 + 0.4 * rng()));
			const start = descent.points[i];
			const swing = (0.5 + rng()) * (rng() < 0.5 ? -1 : 1);
			const away = drift * (0.6 + 0.8 * rng());
			const end: Vec = look === 'strikes'
				? [strike[0] + Math.cos(toward + swing) * away, strike[1] + Math.sin(toward + swing) * away, 0]
				: [start[0] + Math.cos(toward + swing) * away, start[1] + Math.sin(toward + swing) * away, start[2] * (0.15 + 0.3 * rng())];
			const second = wander(style, start, end, false, 1).map((p) => [p[0], p[1], Math.max(0, p[2])] as Vec);
			w.path(second, descent.from[i], [trunk * 0.85, trunk * 0.75], [0.9, look === 'strikes' ? 0.9 : 0.4], look === 'strikes' ? 0 : 1);
		}
		const branches = look === 'filament' ? Math.floor(rng() * 3) : 3 + Math.floor(rng() * 5);
		branch(w, style, descent, branches, 1, length(sub(strike, top)) * 0.5, trunk * 0.6, 0.8, false, true);
		branch(w, style, leader, Math.floor(rng() * 3), 2, feed * 0.6, trunk * 0.45, 0.5, true, false);
	} else {
		// Leaders spread both ways from where the flash starts, like the roots of a tree.
		const leaders = look === 'filament' ? 1 : look === 'branching' ? 2 : 2 + Math.floor(rng() * 2);
		const reach = CHANNEL.lengthScale * r;
		w.extent = reach * 1.25;
		const style: Style = { rng, minLength: w.extent * SKELETON.detail, tortuosity };
		const paths: Path[] = [];
		for (let k = 0; k < leaders; k++) {
			const dir = heading + (k === 1 ? Math.PI : k * 2.1) + (rng() - 0.5) * 0.9;
			const size = reach * (k === 0 ? 0.75 + 0.25 * rng() : 0.35 + 0.55 * rng());
			const end = clampHeight([origin[0] + Math.cos(dir) * size, origin[1] + Math.sin(dir) * size, origin[2] + (rng() - 0.5) * 2.5]);
			const strength = k === 0 ? 1 : 0.6 + 0.35 * rng();
			paths.push(w.path(wander(style, origin, end, true, rng() < 0.5 ? 2 : 1).map(clampHeight), 0, [trunk, trunk * 0.6], [strength, strength * 0.55], 0));
		}
		const branches = look === 'filament' ? Math.floor(rng() * 2) : look === 'branching' ? 2 + Math.floor(rng() * 4) : 4 + Math.floor(rng() * 6);
		for (const path of paths) branch(w, style, path, Math.ceil(branches / leaders), 1, reach * 0.7, trunk * 0.6, 0.7, true, false);
	}
	// Arrival as a share of the longest path, so leaders end their growth together.
	let longest = 0;
	for (let k = 0; k < w.count; k++) longest = Math.max(longest, w.data[k * SEGMENT_FLOATS + 9]);
	for (let k = 0; k < w.count; k++) {
		w.data[k * SEGMENT_FLOATS + 8] /= longest;
		w.data[k * SEGMENT_FLOATS + 9] /= longest;
	}
	return { look, kind, count: w.count, data: w.data };
}
