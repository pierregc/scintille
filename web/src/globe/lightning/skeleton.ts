import { CHANNEL, channelHash, KIND } from './channel';
import { FlashKind, isGround } from './kind';
import { flickerLength, PROFILE } from './profile';

/**
 * Floats per channel segment: start xyz, width (CSS px), end xyz, light, path arrival at start and end, level, cloud flag.
 * Level: 0 the main channel, 1 to 3 branches by depth, 4 a second ground contact path (ADR 0033; #402 lights it from a later stroke).
 * Cloud flag: 0 clear air (crisp, with a halo), 1 in the cloud (veiled by depth), 2 a trace in the cloud (crisp, at least 30 % of its light).
 * Arrival: the in-cloud stem (a cloud-to-ground feed, an in-cloud trunk) is run by `SKELETON.stemArrival`; a
 * cloud-to-ground drop then reaches its strike at 1, its branches within it; in-cloud fans end their growth together at 1.
 */
export const SEGMENT_FLOATS = 12;
export const MAX_SEGMENTS = 256;

/** Silhouettes a flash can take; drawn from its seed, never observed. */
export type Look = 'filament' | 'branching' | 'network';

export interface Skeleton {
	look: Look;
	kind: FlashKind;
	/** Observed duration the skeleton is drawn for, ms. */
	durationMs: number;
	/** Segments written in `data`. */
	count: number;
	data: Float32Array;
}

/** Shape choices in km above the ground, observed radii (r) and CSS px, besides the kind bounds of `KIND`; see docs/flash-profile.md. */
export const SKELETON = {
	/** The cloud is assumed between these heights: a channel under its base is in clear air. */
	cloudBaseKm: 7,
	cloudTopKm: 11.5,
	/** In-cloud fans spread between these heights, crawlers along the cloud base between these. */
	fanKm: [8.5, 11.5],
	crawlerKm: [6, 8],
	/** Vertical share of the sideways offsets of fans and of crawlers, which keep to a layer. */
	fanFlatten: 0.3,
	crawlerFlatten: 0.15,
	/** In-cloud trunks climb this much, km. */
	trunkClimbKm: [2, 4],
	/** Cloud-to-ground origins, trunk feet and crawler starts spread over this disc around the position, r. */
	originR: 0.5,
	/** A negative feed ends within this of the position, r, leaving its drop room in the footprint. */
	feedWithinR: 0.8,
	/** A negative drop bears within this of its feed, radians; a positive one aims at the kind's `strikeR` ring. */
	dropBearing: Math.PI / 3,
	/** Cloud-to-ground branches leave the drop between these heights and end this high above the ground, km. */
	branchFromKm: [1.5, 5],
	branchEndKm: [0.3, 2],
	/** Branch deflection from its parent, degrees: narrow for `narrowShare` of branches, wide otherwise; length over its parent. */
	deflectionDeg: [
		[20, 40],
		[45, 75],
	],
	narrowShare: 0.7,
	branchLength: [0.1, 0.5],
	/** Second ground contact: share of multi-stroke flashes; height it leaves a branch at and distance from the first foot, km. */
	secondShare: 0.4,
	secondFromKm: [1, 3],
	secondAwayKm: [1, 4],
	/** Cloud-to-air: outer share of the longest fan out of the cloud, ending this far beyond the fan or up to this above the top, km. */
	airShare: [0.3, 0.6],
	airBeyondKm: [1, 3],
	airAboveTopKm: 1,
	/** Path arrival by which the in-cloud stem is run. */
	stemArrival: 0.15,
	/** Cloud-to-ground heights scale about the ground by this (1: not exaggerated; at most 1.5, ADR 0033), the origin kept under `maxOriginKm`. */
	cgHeightScale: 1,
	maxOriginKm: 11,
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
type Range = readonly [number, number];

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

const DEG = Math.PI / 180;
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const length = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec): Vec => {
	const n = length(a) || 1;
	return [a[0] / n, a[1] / n, a[2] / n];
};
const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const within = (range: Range, t: number): number => range[0] + (range[1] - range[0]) * t;
/** Whole number drawn evenly from `range`, both ends included. */
const count = (range: Range, t: number): number => Math.min(range[1], range[0] + Math.floor((range[1] - range[0] + 1) * t));
/** The point `run` km from `p` horizontally on `bearing`, at height `z`. */
const toward = (p: Vec, bearing: number, run: number, z = p[2]): Vec => [p[0] + Math.cos(bearing) * run, p[1] + Math.sin(bearing) * run, z];
const layer = (heights: Range) => (p: Vec): Vec => [p[0], p[1], Math.min(heights[1], Math.max(heights[0], p[2]))];
const aboveGround = (floor: number) => (p: Vec): Vec => [p[0], p[1], Math.max(floor, p[2])];

interface Path {
	points: Vec[];
	/** Path length run by the leaders at each point, km. */
	from: number[];
}

interface Style {
	rng: () => number;
	minLength: number;
	tortuosity: number;
}

/** Unit vector at right angles to `d`, random around it, its vertical part scaled by `flatten` for paths that keep to a layer. */
function across(d: Vec, rng: () => number, flatten: number): Vec {
	const u = unit(d);
	const ref: Vec = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	const p = unit([u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]);
	const q: Vec = [u[1] * p[2] - u[2] * p[1], u[2] * p[0] - u[0] * p[2], u[0] * p[1] - u[1] * p[0]];
	const angle = rng() * 2 * Math.PI;
	const v: Vec = add([p[0] * Math.cos(angle), p[1] * Math.cos(angle), p[2] * Math.cos(angle)], q, Math.sin(angle));
	v[2] *= flatten;
	return v;
}

const gauss = (rng: () => number): number => (rng() + rng() + rng() - 1.5) * 1.15;

/**
 * A path from `a` to `b` with deviations at three scales: one or two broad bends (an elbow or an S),
 * then midpoints displaced sideways at uneven places, less at each finer level.
 */
function wander(style: Style, a: Vec, b: Vec, flatten: number, bends: number): Vec[] {
	const { rng } = style;
	const span = sub(b, a);
	const total = length(span);
	const anchors: Vec[] = [a];
	let side = rng() < 0.5 ? -1 : 1;
	for (let k = 1; k <= bends; k++) {
		const t = (k - 0.35 + rng() * 0.7) / (bends + 1);
		const swing = across(span, rng, flatten);
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
		const m = add(lerp(p, q, 0.5 + (rng() - 0.5) * 0.4), across(d, rng, flatten), l * rough * gauss(rng));
		split(p, m, rough * SKELETON.roughnessDecay);
		split(m, q, rough * SKELETON.roughnessDecay);
	};
	const rough = within(SKELETON.roughness, rng()) * style.tortuosity;
	for (let k = 1; k < anchors.length; k++) split(anchors[k - 1], anchors[k], rough);
	return points;
}

const pathLength = (points: Vec[]): number => points.reduce((sum, p, k) => (k ? sum + length(sub(p, points[k - 1])) : 0), 0);

/** Cloud flag of a segment from the height of its highest end, km. */
type Flag = (top: number) => number;
const inCloud: Flag = () => 1;
const trace: Flag = () => 2;
const clearAir: Flag = () => 0;
/** A cloud-to-ground path is in the cloud above its base and in clear air below. */
const underBase: Flag = (top) => (top > SKELETON.cloudBaseKm ? 1 : 0);

/** Writes segments, keeping within `MAX_SEGMENTS` less the `reserve` left for a path written later. */
class Writer {
	readonly data = new Float32Array(MAX_SEGMENTS * SEGMENT_FLOATS);
	count = 0;
	reserve = 0;

	/** Writes `points` reached once the leaders have run `from` km, the arrival growing `pace` km per km of path. */
	path(points: Vec[], from: number, width: Range, light: Range, level: number, flag: Flag, pace = 1): Path {
		const out: Path = { points: [points[0]], from: [from] };
		let along = from;
		for (let k = 1; k < points.length; k++) {
			if (this.count >= MAX_SEGMENTS - this.reserve) break;
			const a = points[k - 1];
			const b = points[k];
			const t = (k - 0.5) / (points.length - 1);
			const o = this.count * SEGMENT_FLOATS;
			this.data.set(a, o);
			this.data[o + 3] = Math.max(SKELETON.minWidth, within(width, t));
			this.data.set(b, o + 4);
			this.data[o + 7] = within(light, t);
			this.data[o + 8] = along;
			along += length(sub(b, a)) * pace;
			this.data[o + 9] = along;
			this.data[o + 10] = level;
			this.data[o + 11] = flag(Math.max(a[2], b[2]));
			this.count++;
			out.points.push(b);
			out.from.push(along);
		}
		return out;
	}

	/** Kilometres run by the leaders when the last of them stops. */
	longest(): number {
		let longest = 0;
		for (let k = 0; k < this.count; k++) longest = Math.max(longest, this.data[k * SEGMENT_FLOATS + 9]);
		return longest;
	}

	/** Turns kilometres run into arrivals: the stem's `stem` km into `[0, stemArrival]`, the rest up to `end` km into the remainder up to 1. */
	arrive(stem: number, end: number): void {
		const start = stem > 0 ? SKELETON.stemArrival : 0;
		const at = (x: number) => (x <= stem ? (stem > 0 ? (x / stem) * start : 0) : Math.min(1, start + ((x - stem) / (end - stem)) * (1 - start)));
		for (let o = 0; o < this.count * SEGMENT_FLOATS; o += SEGMENT_FLOATS) {
			this.data[o + 8] = at(this.data[o + 8]);
			this.data[o + 9] = at(this.data[o + 9]);
		}
	}

	/** Draws segments from `first` on toward `centre`, horizontally, so none reaches farther than `reach` km from it. */
	fit(first: number, centre: Vec, reach: number): void {
		const ends = (visit: (o: number) => void) => {
			for (let o = first * SEGMENT_FLOATS; o < this.count * SEGMENT_FLOATS; o += SEGMENT_FLOATS) {
				visit(o);
				visit(o + 4);
			}
		};
		let far = 0;
		ends((o) => (far = Math.max(far, Math.hypot(this.data[o] - centre[0], this.data[o + 1] - centre[1]))));
		if (far <= reach) return;
		ends((o) => {
			this.data[o] = centre[0] + ((this.data[o] - centre[0]) * reach) / far;
			this.data[o + 1] = centre[1] + ((this.data[o + 1] - centre[1]) * reach) / far;
		});
	}

	/** Point `end` of segment `k`: 0 its start, 1 its end. */
	point(k: number, end: 0 | 1): Vec {
		const o = k * SEGMENT_FLOATS + end * 4;
		return [this.data[o], this.data[o + 1], this.data[o + 2]];
	}
}

/** What every part of one flash's channel shares. */
interface Flash {
	w: Writer;
	rng: () => number;
	/** Observed radius, at least 3 km. */
	r: number;
	/** Heading of the first leader, the one the light drifts along (`cloudDrift`). */
	heading: number;
	tortuosity: number;
	/** Core width of its main channel, CSS px. */
	trunk: number;
}

const style = (flash: Flash, extentKm: number): Style => ({ rng: flash.rng, minLength: extentKm * SKELETON.detail, tortuosity: flash.tortuosity });

/** A point drawn evenly over the disc of `radius` km around the position, at height `z`. */
function disc(rng: () => number, radius: number, z: number): Vec {
	const d = Math.sqrt(rng()) * radius;
	const a = rng() * 2 * Math.PI;
	return [Math.cos(a) * d, Math.sin(a) * d, z];
}

/** Horizontal run from `p`, inside the circle of `radius` km around the position, on `bearing` to that circle. */
function runToEdge(p: Vec, bearing: number, radius: number): number {
	const b = p[0] * Math.cos(bearing) + p[1] * Math.sin(bearing);
	const c = p[0] * p[0] + p[1] * p[1] - radius * radius;
	return Math.max(0, -b + Math.sqrt(Math.max(0, b * b - c)));
}

/**
 * Ground point `run` km from `from` horizontally on the bearing nearest `bearing` that falls within `limit` km of the
 * position; failing any, toward the position, the run cut to fit.
 */
function strikeWithin(from: Vec, bearing: number, run: number, limit: number): Vec {
	for (let k = 0; k <= 24; k++) {
		const turn = (k % 2 ? -1 : 1) * Math.ceil(k / 2) * (Math.PI / 12);
		const p = toward(from, bearing + turn, run, 0);
		if (Math.hypot(p[0], p[1]) <= limit) return p;
	}
	const d = Math.hypot(from[0], from[1]);
	const fit = Math.min(Math.max(run, d - 0.95 * limit), d + 0.95 * limit);
	return toward(from, d > 0 ? Math.atan2(-from[1], -from[0]) : bearing, fit, 0);
}

/** Branches off a cloud-to-ground path below `branchFromKm`, down and out on every side, each possibly branching again. */
function groundBranches(flash: Flash, s: Style, parent: Path, n: number, level: number, size: number, width: number, light: number, end: number): Path[] {
	const { w, rng } = flash;
	const out: Path[] = [];
	// Deflections are from the course of the parent, not from its local wiggle.
	const t = unit(sub(parent.points[parent.points.length - 1], parent.points[0]));
	const starts: number[] = [];
	for (let i = 1; i < parent.points.length - 1; i++) {
		const z = parent.points[i][2];
		if (z >= SKELETON.branchFromKm[0] && z <= SKELETON.branchFromKm[1]) starts.push(i);
	}
	for (let k = 0; k < n && starts.length > 0 && w.count < MAX_SEGMENTS - w.reserve - 2; k++) {
		const i = starts[Math.floor(rng() * starts.length)];
		const start = parent.points[i];
		const angle = within(SKELETON.deflectionDeg[rng() < SKELETON.narrowShare ? 0 : 1], rng()) * DEG;
		const dir = add([t[0] * Math.cos(angle), t[1] * Math.cos(angle), t[2] * Math.cos(angle)], across(t, rng, 1), Math.sin(angle));
		// Down and out, never rising nor flat.
		dir[2] = Math.min(dir[2], -0.25);
		// Most branches are short, a few reach half their parent.
		const span = size * within(SKELETON.branchLength, rng() ** 2);
		const tip = add(start, unit(dir), span);
		tip[2] = Math.max(tip[2], Math.min(within(SKELETON.branchEndKm, rng()), start[2] - 0.3));
		const coarse: Style = { ...s, minLength: s.minLength * (level === 1 ? 1.4 : 2) };
		const points = wander(coarse, start, tip, 1, rng() < 0.4 ? 1 : 0).map(aboveGround(0.2));
		const strong = rng() < 0.15 ? 1 : 0.3 + 0.6 * rng();
		// A branch is drawn by the time the leader strikes, as a stepped leader's branches stop when it does.
		const pace = Math.min(1, Math.max(0, end - parent.from[i]) / (pathLength(points) || 1));
		const b = w.path(points, parent.from[i], [width, width * 0.45], [light * strong, light * strong * 0.3], level, underBase, pace);
		out.push(b);
		if (level < 3) {
			const spurs = rng() < 0.45 ? 0 : Math.floor(rng() * (level === 1 ? 4 : 2));
			groundBranches(flash, s, b, spurs, level + 1, span, width * 0.6, light * strong * 0.6, end);
		}
	}
	return out;
}

/** Branches off an in-cloud path at uneven places, most of them on one side, each possibly branching again, kept to `heights`. */
function cloudBranches(flash: Flash, s: Style, parent: Path, n: number, level: number, reach: number, width: number, light: number, heights: Range, flatten: number): void {
	const { w, rng } = flash;
	const keep = layer(heights);
	const favoured = rng() < 0.5 ? -1 : 1;
	const lean = 0.65 + 0.3 * rng();
	const points = parent.points.length;
	for (let k = 0; k < n && w.count < MAX_SEGMENTS - w.reserve - 2 && points > 3; k++) {
		const i = Math.min(points - 2, 1 + Math.floor((0.06 + 0.84 * rng()) * (points - 2)));
		const start = parent.points[i];
		const t = unit(sub(parent.points[i + 1], parent.points[i - 1]));
		const side = rng() < lean ? favoured : -favoured;
		// Most branches leave at 20 to 70 degrees, a few almost square.
		const angle = (rng() < 0.85 ? 0.35 + 0.85 * rng() : 1.3 + 0.3 * rng()) * side;
		const c = Math.cos(angle);
		const sn = Math.sin(angle);
		const dir: Vec = [t[0] * c - t[1] * sn, t[0] * sn + t[1] * c, (rng() - 0.5) * 0.15];
		const size = reach * (rng() < 0.2 ? 0.55 + 0.45 * rng() : 0.15 + 0.4 * rng());
		const tip = keep(add(start, unit(dir), size));
		const coarse: Style = { ...s, minLength: s.minLength * (level === 1 ? 1.4 : 2) };
		const path = wander(coarse, start, tip, flatten, rng() < 0.4 ? 1 : 0).map(keep);
		const strong = rng() < 0.15 ? 1 : 0.55 + 0.35 * rng();
		const b = w.path(path, parent.from[i], [width, width * 0.45], [light * strong, light * strong * 0.3], level, inCloud);
		if (level < 3) {
			const spurs = rng() < 0.45 ? 0 : Math.floor(rng() * (level === 1 ? 4 : 2));
			cloudBranches(flash, s, b, spurs, level + 1, size * 0.6, width * 0.6, light * 0.6, heights, flatten);
		}
	}
}

/**
 * Cloud-to-ground kinds: an in-cloud stem (a feed along the heading; a climb, a run and a cloud exit for a bolt from
 * the blue), then a drop to a strike inside the footprint, branched below `branchFromKm`, and for some multi-stroke
 * flashes a second ground contact.
 */
function groundChannel(flash: Flash, seed: number, kind: FlashKind): Look {
	const { w, rng, r, heading, trunk } = flash;
	const k = KIND[kind];
	const bolt = kind === FlashKind.BoltFromBlue;
	const positive = kind === FlashKind.CgPositive;
	const limit = Math.max(r, k.reachKm);
	const tilt = within(k.inclinationDeg[channelHash(seed, 5) < k.steepShare ? 0 : 1], rng()) * DEG;
	const run = within(k.runR, rng()) * r;
	let stem: Vec[];
	let top: Vec;
	let bearing: number;
	let drop: number;
	if (bolt) {
		const start = disc(rng, SKELETON.originR * r, within(k.footKm, rng()));
		const climbTop = within(k.topKm, rng());
		const lean = within(KIND[FlashKind.IcTrunkFan].inclinationDeg[0], rng()) * DEG;
		const climb = toward(start, heading, (climbTop - start[2]) * Math.tan(lean), climbTop);
		top = toward(climb, heading, Math.min(run, runToEdge(climb, heading, 0.9 * limit)), within(k.originKm, rng()));
		stem = [start, climb, top];
		bearing = heading;
		drop = Math.min(k.strikeKm[1], Math.max(k.strikeKm[0], top[2] * Math.tan(tilt)));
	} else {
		const origin = disc(rng, SKELETON.originR * r, within(k.originKm, rng()));
		top = toward(origin, heading, Math.min(run, runToEdge(origin, heading, (positive ? 1 : SKELETON.feedWithinR) * r)));
		stem = [origin, top];
		const swing = (rng() - 0.5) * 2 * SKELETON.dropBearing;
		const aim = toward([0, 0, 0], heading + swing, within(k.strikeR, rng()) * r);
		bearing = positive ? Math.atan2(aim[1] - top[1], aim[0] - top[0]) : heading + swing;
		drop = top[2] * Math.tan(tilt);
	}
	const strike = strikeWithin(top, bearing, drop, limit);
	const extent = pathLength(stem) + length(sub(strike, top)) * 1.3;
	const s = style(flash, extent);
	let feed: Vec[] = [stem[0]];
	for (let i = 1; i < stem.length; i++) feed = feed.concat(wander(s, stem[i - 1], stem[i], i === 1 && bolt ? 1 : SKELETON.fanFlatten, 1).slice(1).map(layer([0, SKELETON.cloudTopKm])));
	const leader = w.path(feed, 0, [trunk * 0.8, trunk], [0.7, 1], 0, underBase);
	const stemKm = leader.from.at(-1) ?? 0;
	const fall = wander(s, top, strike, 1, rng() < 0.6 ? 2 : 1).map(layer([0, SKELETON.cloudTopKm]));
	const descent = w.path(fall, stemKm, [trunk, trunk], [1, 1], 0, bolt ? clearAir : underBase);
	const end = descent.from.at(-1) ?? stemKm;
	const second = kind === FlashKind.CgMulti && channelHash(seed, 6) < SKELETON.secondShare;
	w.reserve = second ? 24 : 0;
	const branches = groundBranches(flash, s, descent, count(k.branches, rng()), 1, length(sub(strike, top)), trunk * 0.6, 1, end);
	w.reserve = 0;
	if (second) secondContact(flash, s, branches.length ? branches : [descent], descent, strike, end);
	w.arrive(stemKm, end);
	const highest = Math.max(...stem.map((p) => p[2]));
	const scale = Math.min(SKELETON.cgHeightScale, SKELETON.maxOriginKm / highest);
	if (scale !== 1) for (let o = 0; o < w.count * SEGMENT_FLOATS; o += SEGMENT_FLOATS) {
		w.data[o + 2] *= scale;
		w.data[o + 6] *= scale;
	}
	return kind === FlashKind.CgSingle || positive ? 'filament' : 'branching';
}

/** A later stroke's ground contact: from a branch (or the drop) 1 to 3 km up to the ground 1 to 4 km from the first foot. */
function secondContact(flash: Flash, s: Style, branches: Path[], descent: Path, strike: Vec, end: number): void {
	const { w, rng, r, trunk } = flash;
	const low = (path: Path) => path.points.map((p, i) => ({ p, from: path.from[i] })).filter(({ p }) => p[2] >= SKELETON.secondFromKm[0] && p[2] <= SKELETON.secondFromKm[1]);
	let starts = branches.flatMap(low);
	if (!starts.length) starts = low(descent);
	if (!starts.length) return;
	const { p, from } = starts[Math.floor(rng() * starts.length)];
	const foot = strikeWithin(strike, Math.atan2(p[1] - strike[1], p[0] - strike[0]), within(SKELETON.secondAwayKm, rng()), r);
	const points = wander(s, p, foot, 1, 1).map(aboveGround(0));
	const pace = Math.min(1, Math.max(0, end - from) / (pathLength(points) || 1));
	w.path(points, from, [trunk * 0.85, trunk * 0.75], [0.9, 0.9], 4, underBase, pace);
}

/**
 * In-cloud trunk and fans, and cloud-to-air: an oblique trunk climbs from 6-8 km to 9-11 km, then one to three
 * leaders spread both ways from its top, within the footprint and as far as their speed takes them over the flash.
 */
function trunkAndFans(flash: Flash, kind: FlashKind, durationMs: number): Look {
	const { w, rng, r, heading, trunk } = flash;
	const k = KIND[kind];
	const pick = rng();
	const look: Look = pick < 0.2 ? 'filament' : pick < 0.5 ? 'branching' : 'network';
	const foot = disc(rng, SKELETON.originR * r, within(k.originKm, rng()));
	const climb = within([Math.max(SKELETON.trunkClimbKm[0], k.topKm[0] - foot[2]), Math.min(SKELETON.trunkClimbKm[1], k.topKm[1] - foot[2])], rng());
	const lean = within(k.inclinationDeg[0], rng()) * DEG;
	const top = toward(foot, rng() * 2 * Math.PI, climb * Math.tan(lean), foot[2] + climb);
	const reach = Math.min(CHANNEL.lengthScale * r, (k.spreadSpeed * PROFILE.cloudSpread * flickerLength(durationMs)) / 1000);
	const s = style(flash, climb / Math.cos(lean) + reach * 1.25);
	const stem = w.path(wander(s, foot, top, 1, rng() < 0.5 ? 1 : 0), 0, [trunk * 0.9, trunk], [0.8, 1], 0, trace);
	const trunkKm = stem.from.at(-1) ?? 0;
	// Leaders spread both ways from the top of the trunk, like the roots of a tree.
	const leaders = look === 'filament' ? 1 : look === 'branching' ? 2 : 2 + Math.floor(rng() * 2);
	const keep = layer(SKELETON.fanKm);
	const fans = w.count;
	const paths: Path[] = [];
	for (let i = 0; i < leaders; i++) {
		const dir = heading + (i === 1 ? Math.PI : i * 2.1) + (rng() - 0.5) * 0.9;
		const size = reach * (i === 0 ? 0.75 + 0.25 * rng() : 0.35 + 0.55 * rng());
		const tip = keep(toward(top, dir, size, top[2] + (rng() - 0.5) * 2.5));
		const strength = i === 0 ? 1 : 0.6 + 0.35 * rng();
		paths.push(w.path(wander(s, top, tip, SKELETON.fanFlatten, rng() < 0.5 ? 2 : 1).map(keep), trunkKm, [trunk, trunk * 0.6], [strength, strength * 0.55], 0, inCloud));
	}
	const firstFan = paths[0].points.length - 1;
	const branches = look === 'filament' ? Math.floor(rng() * 2) : look === 'branching' ? 2 + Math.floor(rng() * 4) : 4 + Math.floor(rng() * 6);
	for (const path of paths) cloudBranches(flash, s, path, Math.ceil(branches / leaders), 1, reach * 0.7, trunk * 0.6, 0.7, SKELETON.fanKm, SKELETON.fanFlatten);
	w.fit(fans, top, reach);
	if (kind === FlashKind.CloudToAir) leaveCloud(flash, s, fans, fans + firstFan, top);
	w.arrive(trunkKm, w.longest());
	return look;
}

/** Cloud-to-air: the outer part of the first fan, segments `first` to `last`, leaves the cloud and runs on beyond the fan or over the top. */
function leaveCloud(flash: Flash, s: Style, first: number, last: number, top: Vec): void {
	const { w, rng, trunk } = flash;
	const start = w.data[first * SEGMENT_FLOATS + 8];
	const end = w.data[(last - 1) * SEGMENT_FLOATS + 9];
	const out = end - within(SKELETON.airShare, rng()) * (end - start);
	for (let k = first; k < last; k++) if (w.data[k * SEGMENT_FLOATS + 8] >= out) w.data[k * SEGMENT_FLOATS + 11] = 0;
	const tip = w.point(last - 1, 1);
	const z = rng() < 0.5 ? tip[2] : SKELETON.cloudTopKm + SKELETON.airAboveTopKm * rng();
	const beyond = toward(tip, Math.atan2(tip[1] - top[1], tip[0] - top[0]), within(SKELETON.airBeyondKm, rng()), z);
	w.path(wander(s, tip, beyond, 1, 1).map(layer([0, SKELETON.cloudTopKm + SKELETON.airAboveTopKm])), end, [trunk * 0.6, trunk * 0.45], [0.55, 0.3], 0, clearAir);
}

/** Crawler: one or two long leaders along the cloud base, both ways from where it starts, without a trunk. */
function crawler(flash: Flash): Look {
	const { w, rng, r, heading, trunk } = flash;
	const k = KIND[FlashKind.IcCrawler];
	const keep = layer(SKELETON.crawlerKm);
	const start = disc(rng, SKELETON.originR * r, within(SKELETON.crawlerKm, rng()));
	const s = style(flash, k.runR[1] * r * 1.25);
	const leaders = rng() < 0.5 ? 1 : 2;
	const paths: Path[] = [];
	for (let i = 0; i < leaders; i++) {
		const tip = keep(toward(start, heading + i * Math.PI + (rng() - 0.5) * 0.9, within(k.runR, rng()) * r, start[2] + (rng() - 0.5) * 1.5));
		const strength = i === 0 ? 1 : 0.6 + 0.35 * rng();
		paths.push(w.path(wander(s, start, tip, SKELETON.crawlerFlatten, rng() < 0.5 ? 2 : 1).map(keep), 0, [trunk, trunk * 0.6], [strength, strength * 0.55], 0, inCloud));
	}
	const branches = count(k.branches, rng());
	paths.forEach((path, i) => cloudBranches(flash, s, path, Math.floor((branches + i) / leaders), 1, k.runR[0] * r * 0.5, trunk * 0.6, 0.7, SKELETON.crawlerKm, SKELETON.crawlerFlatten));
	w.arrive(0, w.longest());
	return 'filament';
}

/**
 * Procedural channel of a flash of kind `kind`, observed radius `radiusKm` and duration `durationMs`, in km east,
 * north and up from its position. Its silhouette, branches and heights are drawn from `seed` within the bounds of its
 * kind: the satellites only see the light, so none of this is observed.
 */
export function channelSkeleton(seed: number, radiusKm: number, kind: FlashKind, durationMs: number): Skeleton {
	const rng = random(seed);
	const flash: Flash = {
		w: new Writer(),
		rng,
		r: Math.max(3, radiusKm),
		heading: channelHash(seed, 1) * 2 * Math.PI,
		tortuosity: 0.8 + 0.7 * rng(),
		trunk: SKELETON.trunkWidth * (0.85 + 0.4 * rng()),
	};
	const look = isGround(kind) ? groundChannel(flash, seed, kind) : kind === FlashKind.IcCrawler ? crawler(flash) : trunkAndFans(flash, kind, durationMs);
	return { look, kind, durationMs, count: flash.w.count, data: flash.w.data };
}
