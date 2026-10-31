import { FlashKind, isGround } from './kind';

/** Shape of a flash over time; mirrored in the shaders, see docs/flash-profile.md. */
export const PROFILE = {
	/** Flicker phase bounds, seconds of wall clock time: the observed duration, clamped. */
	minFlicker: 0.06,
	maxFlicker: 2,
	/** Gap between strokes, seconds: log-triangular around `pulseGap` (`positiveGap` for positive flashes), from `minGap` to `maxGap`. */
	pulseGap: 0.057,
	positiveGap: 0.094,
	minGap: 0.01,
	maxGap: 0.4,
	maxPulses: 24,
	/** Strokes a flash must hold are brought within this share of the flicker left. */
	fit: 0.8,
	/** Decay constant of a stroke, seconds: the first one between `firstTau`, later ones between `minTau` and `maxTau`; in-cloud pulses between `cloudTau`. */
	firstTau: [0.02, 0.03],
	minTau: 0.01,
	maxTau: 0.03,
	cloudTau: [0.02, 0.06],
	/** Level of each stroke after the first, picked between these bounds. */
	minLevel: 0.3,
	maxLevel: 0.9,
	/** Pulses are averaged over one frame at 60 Hz, like a shutter, so none falls between two frames. */
	shutter: 1 / 60,
	/** A cloud-to-ground leader comes down at this level, within `leaderShare` of the flicker; the first stroke then fills its channel from the ground up in `strokeSweep` seconds. */
	leaderLevel: 0.12,
	leaderShare: 0.5,
	strokeSweep: 0.033,
	/** A dart leader runs down the trunk in `dart` seconds before each later stroke, at `dartLevel`. */
	dart: 0.04,
	dartLevel: 0.3,
	/** Positive flashes strike once in `positiveSingle` of them, otherwise twice; bolts from the blue strike 1, 2 or 3 times in these shares. */
	positiveSingle: 0.81,
	boltStrokes: [0.25, 0.4, 0.35],
	/** Share of flashes holding a continuing current, by cloud-to-ground kind (after strokes 2 to 5 of a multi-stroke flash, the last stroke otherwise), its level and length. */
	currentShare: [0.4, 0.15, 0.75, 0.3],
	currentLevel: [0.2, 0.3],
	currentDuration: [0.04, 0.3],
	/** A single-stroke flash keeps this level of in-cloud activity after its stroke, to the end of its flicker. */
	singleActivity: [0.12, 0.18],
	/** In-cloud flashes glow at `icGlow` while their leaders spread. Shares with no bright pulse (they swell to `icDimPeak`), one, or two to three at least `icGap` apart, later ones at `icLevel`. */
	icGlow: [0.15, 0.25],
	icPulses: [0.25, 0.45, 0.3],
	icDimPeak: [0.35, 0.5],
	icLevel: [0.75, 0.9],
	icGap: 0.06,
	/** The first bright pulse comes after the trunk and before this share of the flicker. */
	icFirstBy: 0.9,
	/** K-changes stutter the glow of in-cloud flashes without a bright pulse or with several, over the last half of the flicker: `stutterShare` of the `stutterBin` bins lit `stutterLevel` above the glow, never above `icDimPeak`. */
	stutterBin: 0.0125,
	stutterShare: 0.4,
	stutterLevel: [0.15, 0.3],
	/** Crawlers hold a steady glow; the tip of their leader shines at full over this share of the path. */
	crawlerGlow: [0.25, 0.35],
	crawlerTip: 0.1,
	/** In-cloud light fades out over this long after the flicker. */
	cloudFade: 0.08,
	/** In-cloud leaders cover their path within this share of the flicker. */
	cloudSpread: 0.8,
	/** Glow left in the cloud, relative to the first pulse. */
	afterglow: 0.12,
	/** Wall clock life of a flash: at least `life`, and `tail` past its flicker. */
	life: 1,
	tail: 0.5,
	/** Afterglow windows of minutes dim as `(glowRef / display) ^ glowScale`, so more flashes on screen stay readable. */
	glowRef: 300,
	glowScale: 1,
	/** Glow decay time constant, as a fraction of its window. */
	glowTau: 0.25,
	/** Fall and rise of the reduced-motion fade, seconds. */
	softFall: 0.25,
	softRise: 0.06,
} as const;

/** Wall seconds a flash takes to propagate (`flashTiming` in channel.ts): its leader down to the first stroke or up its trunk, and the time its leaders take to cover the whole path. */
export interface FlashTiming {
	leader: number;
	spread: number;
}

export interface Pulse {
	start: number;
	level: number;
	tau: number;
}

type Range = readonly [number, number];

function smoothstep(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

const lerp = ([lo, hi]: Range, t: number): number => lo + (hi - lo) * t;
const logLerp = ([lo, hi]: Range, t: number): number => lo * (hi / lo) ** t;

/** Afterglow level for a window of `display` seconds of scene time. */
export function glowLevel(display: number): number {
	return PROFILE.afterglow * Math.min(1, (PROFILE.glowRef / display) ** PROFILE.glowScale);
}

/** Exponential fade over a window, from 1 at `t` = 0 to exactly 0 at `t` = 1. */
export function glowDecay(t: number): number {
	const end = Math.exp(-1 / PROFILE.glowTau);
	return (Math.exp(-t / PROFILE.glowTau) - end) / (1 - end);
}

/** Flicker phase length in wall clock seconds for an observed flash duration in milliseconds. */
export function flickerLength(durationMs: number): number {
	return Math.min(PROFILE.maxFlicker, Math.max(PROFILE.minFlicker, durationMs / 1000));
}

/** Wall clock seconds a flash stays lit without afterglow. */
export function flashLife(flicker: number): number {
	return Math.max(PROFILE.life, flicker + PROFILE.tail);
}

export const MAX_LIFE = flashLife(PROFILE.maxFlicker);

/** Per-flash hash in [0, 1) for draw `k`. */
export function pulseHash(seed: number, k: number): number {
	const x = Math.sin(seed * 91.345 + k * 47.853) * 43758.5453;
	return x - Math.floor(x);
}

/** Gap before stroke `k`, seconds: log-triangular around `mean`, within `minGap` to `maxGap`. */
export function pulseGap(seed: number, k: number, mean: number = PROFILE.pulseGap): number {
	const t = pulseHash(seed, 10 + k) + pulseHash(seed, 30 + k) - 1;
	const span = t >= 0 ? PROFILE.maxGap / mean : mean / PROFILE.minGap;
	return mean * span ** t;
}

/** Share of its path a flash has lit `age` seconds in: eased as leaders slow down, at a steady pace for crawlers. */
export function spread(age: number, timing: FlashTiming, kind: FlashKind): number {
	const t = Math.min(1, Math.max(0, age / timing.spread));
	return kind === FlashKind.IcCrawler ? t : 1 - (1 - t) * (1 - t);
}

/** Strokes a cloud-to-ground flash holds at most, and how many of them its flicker must hold. */
function strokeCounts(kind: FlashKind, seed: number): [number, number] {
	const u = pulseHash(seed, 98);
	if (kind === FlashKind.CgMulti) return [PROFILE.maxPulses, 2];
	if (kind === FlashKind.CgPositive) return u < PROFILE.positiveSingle ? [1, 1] : [2, 2];
	if (kind === FlashKind.BoltFromBlue) {
		const [one, two] = PROFILE.boltStrokes;
		const n = u < one ? 1 : u < one + two ? 2 : 3;
		return [n, n];
	}
	return [1, 1];
}

/** Start of stroke `k` after one at `start`: strokes the flicker must hold are brought closer so they fit. */
function nextStroke(kind: FlashKind, seed: number, k: number, start: number, length: number, forced: number): number {
	let gap = pulseGap(seed, k, kind === FlashKind.CgPositive ? PROFILE.positiveGap : PROFILE.pulseGap);
	if (k < forced) gap = Math.min(gap, (PROFILE.fit * (length - start)) / (forced - k));
	return start + gap;
}

const strokeLevel = (seed: number, k: number): number => (k === 0 ? 1 : PROFILE.minLevel + (PROFILE.maxLevel - PROFILE.minLevel) * pulseHash(seed, 70 + k));
const strokeTau = (seed: number, k: number): number => logLerp(k === 0 ? PROFILE.firstTau : [PROFILE.minTau, PROFILE.maxTau], pulseHash(seed, 50 + k));

/** Strokes of a cloud-to-ground flash in a flicker of `length` seconds, the first at the end of its leader. */
export function strokeTrain(kind: FlashKind, length: number, seed: number, leader: number): Pulse[] {
	const [most, forced] = strokeCounts(kind, seed);
	const strokes: Pulse[] = [];
	let start = leader;
	for (let k = 0; k < most; k++) {
		if (k > 0) start = nextStroke(kind, seed, k, start, length, forced);
		if (start > length) break;
		strokes.push({ start, level: strokeLevel(seed, k), tau: strokeTau(seed, k) });
	}
	return strokes;
}

/** The stroke a cloud-to-ground flash is in, `wallAge` seconds after it started: its index (−1 during the leader), its age, and the time to the next one (Infinity after the last). */
export function flashStroke(wallAge: number, length: number, seed: number, kind: FlashKind, leader: number): { index: number; age: number; next: number } {
	const [most, forced] = strokeCounts(kind, seed);
	let index = -1;
	let age = wallAge;
	let next = leader - wallAge;
	let start = leader;
	for (let k = 0; k < most; k++) {
		if (k > 0) start = nextStroke(kind, seed, k, start, length, forced);
		if (start > length) break;
		if (start > wallAge) {
			next = start - wallAge;
			break;
		}
		index = k;
		age = wallAge - start;
		next = Infinity;
	}
	return { index, age, next };
}

/** Continuing current of a cloud-to-ground flash: after stroke `stroke` (or its last), at `level`, for `duration` seconds at most; null without one. */
export function continuingCurrent(kind: FlashKind, seed: number): { stroke: number; level: number; duration: number } | null {
	const shares: readonly number[] = PROFILE.currentShare;
	if (!isGround(kind) || pulseHash(seed, 90) >= shares[kind]) return null;
	const stroke = kind === FlashKind.CgMulti ? 1 + Math.floor(4 * pulseHash(seed, 91)) : kind === FlashKind.CgSingle ? 0 : PROFILE.maxPulses;
	return { stroke, level: lerp(PROFILE.currentLevel, pulseHash(seed, 92)), duration: lerp(PROFILE.currentDuration, pulseHash(seed, 93)) };
}

/** Mean over the last shutter time of a pulse that started `a` seconds ago and decays with `tau`. */
function shutterPulse(a: number, tau: number): number {
	if (a <= 0) return 0;
	return (tau / PROFILE.shutter) * (Math.exp(-Math.max(a - PROFILE.shutter, 0) / tau) - Math.exp(-a / tau));
}

/** A continuing current `a` seconds after its stroke: on over the shutter, held for `duration`, off over 30 ms. */
function currentLight(a: number, level: number, duration: number): number {
	return level * smoothstep(0, PROFILE.shutter, a) * (1 - smoothstep(duration, duration + 0.03, a));
}

/** A cloud-to-ground flash: a dim leader, then strokes, dark in between unless a continuing current holds. */
export function groundProfile(wallAge: number, length: number, seed: number, kind: FlashKind, leader: number): number {
	let b = wallAge < leader + PROFILE.shutter ? PROFILE.leaderLevel * smoothstep(0, leader, wallAge) : 0;
	const strokes = strokeTrain(kind, length, seed, leader);
	for (const s of strokes) b = Math.max(b, s.level * shutterPulse(wallAge - s.start, s.tau));
	const current = continuingCurrent(kind, seed);
	if (current) {
		const s = strokes[Math.min(current.stroke, strokes.length - 1)];
		// Held past the stroke's own tail (two decay times), within the flicker.
		b = Math.max(b, currentLight(wallAge - s.start, current.level, Math.min(current.duration + 2 * s.tau, length - s.start)));
	}
	if (kind === FlashKind.CgSingle) {
		const activity = lerp(PROFILE.singleActivity, pulseHash(seed, 95));
		b = Math.max(b, activity * smoothstep(leader, leader + PROFILE.shutter, wallAge) * (1 - smoothstep(length, length + PROFILE.cloudFade, wallAge)));
	}
	return b;
}

/** When the first bright pulse (or the swell of a flash without one) comes: after the trunk, mostly early in the flicker. */
function firstPulse(length: number, seed: number, leader: number): number {
	return leader + pulseHash(seed, 102) ** 2 * (PROFILE.icFirstBy * length - leader);
}

/** Bright pulses of an in-cloud flash: none (an empty list), one, or two to three. */
export function cloudPulses(length: number, seed: number, leader: number): Pulse[] {
	const u = pulseHash(seed, 100);
	const [none, one] = PROFILE.icPulses;
	if (u < none) return [];
	const count = u < none + one ? 1 : pulseHash(seed, 101) < 0.5 ? 2 : 3;
	const pulses: Pulse[] = [];
	let start = firstPulse(length, seed, leader);
	for (let k = 0; k < count; k++) {
		if (k > 0) start += Math.max(PROFILE.icGap, pulseGap(seed, k));
		if (start > length) break;
		pulses.push({ start, level: k === 0 ? 1 : lerp(PROFILE.icLevel, pulseHash(seed, 70 + k)), tau: logLerp(PROFILE.cloudTau, pulseHash(seed, 50 + k)) });
	}
	return pulses;
}

/** K-changes over the last half of the flicker, averaged over the shutter: lit bins add their level to the glow. */
export function stutterLight(wallAge: number, length: number, seed: number): number {
	const { stutterBin: bin, shutter } = PROFILE;
	const from = 0.5 * length;
	const first = Math.max(0, Math.floor((wallAge - shutter - from) / bin));
	const last = Math.floor((wallAge - from) / bin);
	let sum = 0;
	for (let j = first; j <= last && j < first + 3; j++) {
		const a = from + j * bin;
		const overlap = Math.min(a + bin, length, wallAge) - Math.max(a, wallAge - shutter);
		if (overlap > 0 && pulseHash(seed, 140 + j) < PROFILE.stutterShare) sum += lerp(PROFILE.stutterLevel, pulseHash(seed, 170 + j)) * overlap;
	}
	return sum / shutter;
}

/** An in-cloud flash: its trunk rises, its leaders glow as they spread, with bright pulses or a dim swell and stutters at the end; crawlers glow steadily. All fade after the flicker. */
export function cloudProfile(wallAge: number, length: number, seed: number, kind: FlashKind, timing: FlashTiming): number {
	const fade = 1 - smoothstep(length, length + PROFILE.cloudFade, wallAge);
	if (kind === FlashKind.IcCrawler) return lerp(PROFILE.crawlerGlow, pulseHash(seed, 94)) * smoothstep(0, Math.min(0.03, 0.05 * length), wallAge) * fade;
	const glow = lerp(PROFILE.icGlow, pulseHash(seed, 94)) * smoothstep(0, timing.leader, wallAge) * fade;
	const pulses = cloudPulses(length, seed, timing.leader);
	let b = 0;
	if (pulses.length === 0) {
		const start = firstPulse(length, seed, timing.leader);
		b = lerp(PROFILE.icDimPeak, pulseHash(seed, 103)) * smoothstep(start - 0.04, start, wallAge) * Math.exp(-Math.max(wallAge - start, 0) / 0.12) * fade;
	}
	for (const p of pulses) b = Math.max(b, p.level * shutterPulse(wallAge - p.start, p.tau));
	const stutter = pulses.length === 1 ? 0 : stutterLight(wallAge, length, seed);
	return Math.max(b, Math.min(glow + stutter, PROFILE.icDimPeak[1]));
}

/**
 * Brightness in [0, 1] of a flash `wallAge` seconds of wall clock time after it started, `sceneAge`
 * seconds of scene time, with an afterglow of `display` seconds of scene time (0 for none).
 * `flicker` false gives the soft single fade used for reduced motion. Cloud-to-ground kinds come
 * down as a dim leader, then strike; in-cloud kinds glow, with bright pulses or not.
 */
export function flashProfile(
	wallAge: number,
	sceneAge: number,
	display: number,
	durationMs: number,
	seed: number,
	flicker: boolean,
	kind: FlashKind,
	timing: FlashTiming,
): number {
	if (sceneAge < 0 || wallAge < 0) return 0;
	const length = flickerLength(durationMs);
	const life = flashLife(length);
	let glow = display > 0 && sceneAge <= display ? glowLevel(display) * glowDecay(sceneAge / display) : 0;
	if (wallAge > life) return glow;
	glow = Math.max(glow, PROFILE.afterglow * glowDecay(wallAge / life));
	if (!flicker) return smoothstep(0, PROFILE.softRise, wallAge) * Math.max(Math.exp(-wallAge / PROFILE.softFall), glow);
	const b = isGround(kind) ? groundProfile(wallAge, length, seed, kind, timing.leader) : cloudProfile(wallAge, length, seed, kind, timing);
	return Math.max(b, glow * smoothstep(0, length, wallAge));
}

/** GLSL float literal: GLSL ES has no implicit int to float conversion. */
export const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

const f = glslFloat;
const P = PROFILE;
const mix = ([lo, hi]: Range, t: string): string => `mix(${f(lo)}, ${f(hi)}, ${t})`;
const logMix = ([lo, hi]: Range, t: string): string => `${f(lo)} * pow(${f(hi)} / ${f(lo)}, ${t})`;

/** GLSL twins of `spread`, `flashStroke` and `flashProfile`; need `channelGlsl` (`isGround`, `flashTiming`). The shaders pass the radius, from which `flashProfile` takes the timing. */
export const flashProfileGlsl = /* glsl */ `
float pulseHash(float seed, float k) {
	return fract(sin(seed * 91.345 + k * 47.853) * 43758.5453);
}
float glowDecay(float t) {
	float end = exp(${f(-1 / P.glowTau)});
	return (exp(-t / ${f(P.glowTau)}) - end) / (1.0 - end);
}
float spread(float age, vec2 timing, int kind) {
	float t = clamp(age / timing.y, 0.0, 1.0);
	return kind == ${FlashKind.IcCrawler} ? t : 1.0 - (1.0 - t) * (1.0 - t);
}
float pulseGap(float seed, float k, float mean) {
	float t = pulseHash(seed, 10.0 + k) + pulseHash(seed, 30.0 + k) - 1.0;
	return mean * pow(t >= 0.0 ? ${f(P.maxGap)} / mean : mean / ${f(P.minGap)}, t);
}
vec2 strokeCounts(int kind, float seed) {
	float u = pulseHash(seed, 98.0);
	if (kind == ${FlashKind.CgMulti}) return vec2(${f(P.maxPulses)}, 2.0);
	if (kind == ${FlashKind.CgPositive}) return vec2(u < ${f(P.positiveSingle)} ? 1.0 : 2.0);
	if (kind == ${FlashKind.BoltFromBlue}) return vec2(u < ${f(P.boltStrokes[0])} ? 1.0 : u < ${f(P.boltStrokes[0] + P.boltStrokes[1])} ? 2.0 : 3.0);
	return vec2(1.0);
}
float nextStroke(int kind, float seed, float k, float start, float len, float forced) {
	float gap = pulseGap(seed, k, kind == ${FlashKind.CgPositive} ? ${f(P.positiveGap)} : ${f(P.pulseGap)});
	if (k < forced) gap = min(gap, ${f(P.fit)} * (len - start) / (forced - k));
	return start + gap;
}
float strokeLevel(float seed, float k) {
	return k < 0.5 ? 1.0 : ${mix([P.minLevel, P.maxLevel], 'pulseHash(seed, 70.0 + k)')};
}
float strokeTau(float seed, float k) {
	return k < 0.5 ? ${logMix(P.firstTau, 'pulseHash(seed, 50.0)')} : ${logMix([P.minTau, P.maxTau], 'pulseHash(seed, 50.0 + k)')};
}
float shutterPulse(float a, float tau) {
	return a <= 0.0 ? 0.0 : tau / ${f(P.shutter)} * (exp(-max(a - ${f(P.shutter)}, 0.0) / tau) - exp(-a / tau));
}
// The stroke a cloud-to-ground flash is in: index (-1 during the leader), age, time to the next one (1e6 after the last).
vec3 flashStroke(float wallAge, float len, float seed, int kind, float leader) {
	vec2 counts = strokeCounts(kind, seed);
	vec3 stroke = vec3(-1.0, wallAge, leader - wallAge);
	float start = leader;
	for (int i = 0; i < ${P.maxPulses}; i++) {
		float k = float(i);
		if (k >= counts.x) break;
		if (i > 0) start = nextStroke(kind, seed, k, start, len, counts.y);
		if (start > len) break;
		if (start > wallAge) {
			stroke.z = start - wallAge;
			break;
		}
		stroke = vec3(k, wallAge - start, 1e6);
	}
	return stroke;
}
float currentLight(float a, float level, float duration) {
	return level * smoothstep(0.0, ${f(P.shutter)}, a) * (1.0 - smoothstep(duration, duration + 0.03, a));
}
float groundProfile(float wallAge, float len, float seed, int kind, float leader) {
	float b = wallAge < leader + ${f(P.shutter)} ? ${f(P.leaderLevel)} * smoothstep(0.0, leader, wallAge) : 0.0;
	vec2 counts = strokeCounts(kind, seed);
	float currentStroke = kind == ${FlashKind.CgMulti} ? 1.0 + floor(4.0 * pulseHash(seed, 91.0)) : kind == ${FlashKind.CgSingle} ? 0.0 : ${f(P.maxPulses)};
	vec2 current = vec2(-1.0);
	vec2 last = vec2(-1.0);
	bool ended = true;
	float start = leader;
	for (int i = 0; i < ${P.maxPulses}; i++) {
		float k = float(i);
		if (k >= counts.x) break;
		if (i > 0) start = nextStroke(kind, seed, k, start, len, counts.y);
		if (start > len) break;
		if (start > wallAge) {
			ended = false;
			break;
		}
		b = max(b, strokeLevel(seed, k) * shutterPulse(wallAge - start, strokeTau(seed, k)));
		last = vec2(start, k);
		if (k == currentStroke) current = last;
	}
	float share = kind == ${FlashKind.CgMulti} ? ${f(P.currentShare[0])} : kind == ${FlashKind.CgSingle} ? ${f(P.currentShare[1])} : kind == ${FlashKind.CgPositive} ? ${f(P.currentShare[2])} : ${f(P.currentShare[3])};
	if (current.x < 0.0 && ended) current = last;
	if (pulseHash(seed, 90.0) < share && current.x >= 0.0) {
		float duration = min(${mix(P.currentDuration, 'pulseHash(seed, 93.0)')} + 2.0 * strokeTau(seed, current.y), len - current.x);
		b = max(b, currentLight(wallAge - current.x, ${mix(P.currentLevel, 'pulseHash(seed, 92.0)')}, duration));
	}
	if (kind == ${FlashKind.CgSingle}) {
		b = max(b, ${mix(P.singleActivity, 'pulseHash(seed, 95.0)')} * smoothstep(leader, leader + ${f(P.shutter)}, wallAge) * (1.0 - smoothstep(len, len + ${f(P.cloudFade)}, wallAge)));
	}
	return b;
}
float stutterLight(float wallAge, float len, float seed) {
	float from = 0.5 * len;
	float first = max(0.0, floor((wallAge - ${f(P.shutter)} - from) / ${f(P.stutterBin)}));
	float last = floor((wallAge - from) / ${f(P.stutterBin)});
	float sum = 0.0;
	for (int i = 0; i < 3; i++) {
		float j = first + float(i);
		if (j > last) break;
		float a = from + j * ${f(P.stutterBin)};
		float overlap = min(min(a + ${f(P.stutterBin)}, len), wallAge) - max(a, wallAge - ${f(P.shutter)});
		if (overlap > 0.0 && pulseHash(seed, 140.0 + j) < ${f(P.stutterShare)}) sum += ${mix(P.stutterLevel, 'pulseHash(seed, 170.0 + j)')} * overlap;
	}
	return sum / ${f(P.shutter)};
}
float cloudProfile(float wallAge, float len, float seed, int kind, vec2 timing) {
	float fade = 1.0 - smoothstep(len, len + ${f(P.cloudFade)}, wallAge);
	if (kind == ${FlashKind.IcCrawler}) return ${mix(P.crawlerGlow, 'pulseHash(seed, 94.0)')} * smoothstep(0.0, min(0.03, 0.05 * len), wallAge) * fade;
	float glow = ${mix(P.icGlow, 'pulseHash(seed, 94.0)')} * smoothstep(0.0, timing.x, wallAge) * fade;
	float u = pulseHash(seed, 100.0);
	float start = timing.x + pow(pulseHash(seed, 102.0), 2.0) * (${f(P.icFirstBy)} * len - timing.x);
	float b = 0.0;
	float pulses = 0.0;
	if (u < ${f(P.icPulses[0])}) {
		b = ${mix(P.icDimPeak, 'pulseHash(seed, 103.0)')} * smoothstep(start - 0.04, start, wallAge) * exp(-max(wallAge - start, 0.0) / 0.12) * fade;
	} else {
		float count = u < ${f(P.icPulses[0] + P.icPulses[1])} ? 1.0 : pulseHash(seed, 101.0) < 0.5 ? 2.0 : 3.0;
		for (int i = 0; i < 3; i++) {
			float k = float(i);
			if (k >= count) break;
			if (i > 0) start += max(${f(P.icGap)}, pulseGap(seed, k, ${f(P.pulseGap)}));
			if (start > len) break;
			pulses += 1.0;
			float level = i == 0 ? 1.0 : ${mix(P.icLevel, 'pulseHash(seed, 70.0 + k)')};
			b = max(b, level * shutterPulse(wallAge - start, ${logMix(P.cloudTau, 'pulseHash(seed, 50.0 + k)')}));
		}
	}
	float stutter = pulses == 1.0 ? 0.0 : stutterLight(wallAge, len, seed);
	return max(b, min(glow + stutter, ${f(P.icDimPeak[1])}));
}
float flashProfile(float wallAge, float sceneAge, float display, float durationMs, float seed, float flicker, int kind, float radiusKm) {
	if (sceneAge < 0.0 || wallAge < 0.0) return 0.0;
	float len = clamp(durationMs / 1000.0, ${f(P.minFlicker)}, ${f(P.maxFlicker)});
	float life = max(${f(P.life)}, len + ${f(P.tail)});
	float glow = display > 0.0 && sceneAge <= display
		? ${f(P.afterglow)} * min(1.0, pow(${f(P.glowRef)} / display, ${f(P.glowScale)})) * glowDecay(sceneAge / display)
		: 0.0;
	if (wallAge > life) return glow;
	glow = max(glow, ${f(P.afterglow)} * glowDecay(wallAge / life));
	if (flicker < 0.5) return smoothstep(0.0, ${f(P.softRise)}, wallAge) * max(exp(-wallAge / ${f(P.softFall)}), glow);
	vec2 timing = flashTiming(kind, radiusKm, len, seed);
	float b = isGround(kind) ? groundProfile(wallAge, len, seed, kind, timing.x) : cloudProfile(wallAge, len, seed, kind, timing);
	return max(b, glow * smoothstep(0.0, len, wallAge));
}
`;
