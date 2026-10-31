import { FlashKind, isGround } from './kind';
import { glslFloat, PROFILE, spread } from './profile';

/** Thin lightning channel drawn over the glow while a flash flickers; see docs/flash-profile.md. */
export const CHANNEL = {
	/** Channel half-length relative to the flash radius, always physical. */
	lengthScale: 2.2,
	/** The channel fades out this long after the flicker phase, seconds. */
	fade: 0.15,
	/** Branches light once, when reached: their decay constant for ground and in-cloud flashes, seconds. */
	branchTau: 0.06,
	cloudBranchTau: 0.12,
	/** Share of an in-cloud path lit at the first pulse; the leaders then cover the rest. */
	cloudStart: 0.2,
	/** Share of a channel's light left over sunlit clouds, which outshine a thin channel seen from orbit. */
	dayLevel: 0.3,
	/** In-cloud light drifts along the channel over the flash, this many observed radii either side of the position. */
	drift: 0.6,
	/** Share of the glow held back while the channel shows, so the cloud does not wash it out. */
	glowDip: 0.6,
	haloGlowDip: 0.9,
	cloudGlowDip: 0.75,
	haloCapacity: 256,
	haloFadeStartKm: 1500,
	haloFadeEndKm: 6000,
} as const;

/** Cumulative shares of the cloud-to-ground kinds over `channelHash(seed, 2)`: negative multi-stroke 19 %, single-stroke 7 %, positive 3 %, bolt from the blue 1 % (30 % in all; observed band 15 to 40 %). */
export const KIND_SHARES = [0.19, 0.26, 0.29, 0.3] as const;
/** In-cloud flashes observed at least this long or this large are drawn as crawlers: the satellite signature of stratiform flashes. */
export const CRAWLER = { minDurationMs: 600, minAreaKm2: 1500 } as const;
/** Share of all flashes drawn cloud-to-air, taken from the in-cloud draws. */
export const CLOUD_TO_AIR_SHARE = 0.03;
const cloudToAirBelow = Number((KIND_SHARES[3] + CLOUD_TO_AIR_SHARE).toFixed(4));
/** Pace of a flash's leaders, drawn once per flash: the kind's speeds times this. */
export const PACE = [0.75, 1.35] as const;

/** Bounds of a kind's procedural geometry and propagation, from the literature (ADR 0033): km above ground, r = observed radius, degrees, m/s, wall seconds. #401 draws the geometry, #402 the timing. */
export interface KindShape {
	/** Where the visible leader starts: the top of a cloud-to-ground drop, the foot of an in-cloud trunk. */
	originKm: [number, number];
	/** Top of the in-cloud trunk; the origin itself for kinds without one. */
	topKm: [number, number];
	/** In-cloud run over r: the feed of a cloud-to-ground kind, the fans of an in-cloud one. */
	runR: [number, number];
	/** Horizontal distance from the origin to the strike, km; the strike also stays within `max(r, reachKm)` of the position. */
	strikeKm: [number, number];
	reachKm: number;
	/** Inclination of the drop or trunk from the vertical: the steep band, the shallow band, and the share of flashes in the steep one. */
	inclinationDeg: [[number, number], [number, number]];
	steepShare: number;
	/** Leader speed down the drop or up the trunk, fan speed across the cloud; the leader time on screen is clamped to `leaderBounds`. */
	leaderSpeed: number;
	spreadSpeed: number;
	leaderBounds: [number, number];
	branches: [number, number];
}

const cgMulti: KindShape = {
	originKm: [6, 8],
	topKm: [6, 8],
	runR: [0.3, 0.8],
	strikeKm: [2, 8],
	reachKm: 0,
	inclinationDeg: [[0, 30], [30, 45]],
	steepShare: 0.8,
	leaderSpeed: 1e5,
	spreadSpeed: 1e5,
	leaderBounds: [0.05, 0.15],
	branches: [3, 12],
};
const icTrunkFan: KindShape = {
	originKm: [6, 8],
	topKm: [9, 11],
	runR: [0.8, 2.2],
	strikeKm: [0, 0],
	reachKm: 0,
	inclinationDeg: [[15, 40], [15, 40]],
	steepShare: 1,
	leaderSpeed: 2e5,
	spreadSpeed: 8e4,
	leaderBounds: [0.01, 0.02],
	branches: [0, 9],
};

/** Per-kind bounds, indexed by `FlashKind`. */
export const KIND: readonly KindShape[] = [
	cgMulti,
	{ ...cgMulti, branches: [1, 3] },
	{
		originKm: [9, 11],
		topKm: [9, 11],
		runR: [0.8, 2.2],
		strikeKm: [6, 10],
		reachKm: 0,
		inclinationDeg: [[30, 45], [30, 45]],
		steepShare: 1,
		leaderSpeed: 1e5,
		spreadSpeed: 1e5,
		leaderBounds: [0.05, 0.15],
		branches: [0, 3],
	},
	{
		originKm: [8, 9],
		topKm: [9, 10],
		runR: [0.5, 1],
		strikeKm: [5, 12],
		reachKm: 8,
		inclinationDeg: [[45, 60], [45, 60]],
		steepShare: 1,
		leaderSpeed: 1.5e5,
		spreadSpeed: 1.5e5,
		leaderBounds: [0.15, 0.25],
		branches: [3, 8],
	},
	icTrunkFan,
	{
		originKm: [6, 8],
		topKm: [6, 8],
		runR: [1.76, 2.2],
		strikeKm: [0, 0],
		reachKm: 0,
		inclinationDeg: [[90, 90], [90, 90]],
		steepShare: 1,
		leaderSpeed: 1e5,
		spreadSpeed: 1e5,
		leaderBounds: [0, 0],
		branches: [0, 3],
	},
	icTrunkFan,
];

/** Per-flash seed in [0, 1) from its event time (UTC ms) and position, stable across rebases and revisits. */
export function flashSeed(timeMs: number, lat: number, lon: number): number {
	return channelHash((timeMs % 86_400_000) + lat * 100 + lon, 0);
}

/** Per-flash hash in [0, 1) for draw `k`, so each shape detail is independent. */
export function channelHash(seed: number, k: number): number {
	const x = Math.sin(seed * 78.233 + k * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

/** The look a flash is drawn in: cloud-to-ground kinds by their shares, crawlers from the observed duration and area, cloud-to-air and trunk-and-fan for the rest. */
export function flashKind(seed: number, durationMs: number, areaKm2: number): FlashKind {
	const u = channelHash(seed, 2);
	if (u < KIND_SHARES[0]) return FlashKind.CgMulti;
	if (u < KIND_SHARES[1]) return FlashKind.CgSingle;
	if (u < KIND_SHARES[2]) return FlashKind.CgPositive;
	if (u < KIND_SHARES[3]) return FlashKind.BoltFromBlue;
	if (durationMs >= CRAWLER.minDurationMs || areaKm2 >= CRAWLER.minAreaKm2) return FlashKind.IcCrawler;
	if (u < cloudToAirBelow) return FlashKind.CloudToAir;
	return FlashKind.IcTrunkFan;
}

const DEG = Math.PI / 180;
const mean = (range: readonly [number, number]): number => (range[0] + range[1]) / 2;

function pace(seed: number): number {
	return PACE[0] + (PACE[1] - PACE[0]) * channelHash(seed, 4);
}

/** Mean climb of a kind's leader, km (the drop of a cloud-to-ground kind), and its horizontal run before the footprint bounds it. */
function leaderMeans(kind: FlashKind): [number, number] {
	const k = KIND[kind];
	const climb = isGround(kind) ? mean(k.originKm) : mean(k.topKm) - mean(k.originKm);
	return [climb, climb * Math.tan(mean(k.inclinationDeg[0]) * DEG)];
}

/** Wall seconds the leader takes down a cloud-to-ground drop or up an in-cloud trunk, at the kind's speed and the flash's pace, within the kind's bounds. */
export function leaderSeconds(kind: FlashKind, radiusKm: number, seed: number): number {
	const k = KIND[kind];
	const [climb, run] = leaderMeans(kind);
	const pathKm = Math.hypot(climb, Math.min(run, Math.max(radiusKm, k.reachKm)));
	const seconds = (pathKm * 1000) / (k.leaderSpeed * pace(seed));
	return Math.min(k.leaderBounds[1], Math.max(k.leaderBounds[0], seconds));
}

/** Wall seconds the leaders take to cover their path: in-cloud fans within `PROFILE.cloudSpread` of the flicker, crawlers within the whole flicker, cloud-to-ground kinds their leader time. */
export function spreadSeconds(kind: FlashKind, radiusKm: number, flicker: number, seed: number): number {
	if (isGround(kind)) return leaderSeconds(kind, radiusKm, seed);
	const k = KIND[kind];
	const share = kind === FlashKind.IcCrawler ? 1 : PROFILE.cloudSpread;
	return Math.min((k.runR[1] * radiusKm * 1000) / (k.spreadSpeed * pace(seed)), share * flicker);
}

const f = glslFloat;
const kindLines = (line: (k: KindShape, kind: FlashKind) => string | null): string =>
	KIND.map((k, i) => line(k, i as FlashKind)).filter((l) => l !== null).join('\n');

/** GLSL twins of `channelHash`, `flashKind`, `isGround`, `leaderSeconds` and `spreadSeconds`; the shaders pass the radius, so the area is `π r²`. */
export const channelGlsl = /* glsl */ `
float channelHash(float seed, float k) {
	return fract(sin(seed * 78.233 + k * 12.9898) * 43758.5453);
}
int flashKind(float seed, float durationMs, float radiusKm) {
	float u = channelHash(seed, 2.0);
	if (u < ${f(KIND_SHARES[0])}) return 0;
	if (u < ${f(KIND_SHARES[1])}) return 1;
	if (u < ${f(KIND_SHARES[2])}) return 2;
	if (u < ${f(KIND_SHARES[3])}) return 3;
	if (durationMs >= ${f(CRAWLER.minDurationMs)} || radiusKm * radiusKm * 3.14159265 >= ${f(CRAWLER.minAreaKm2)}) return 5;
	if (u < ${f(cloudToAirBelow)}) return 6;
	return 4;
}
bool isGround(int kind) {
	return kind <= 3;
}
float pace(float seed) {
	return mix(${f(PACE[0])}, ${f(PACE[1])}, channelHash(seed, 4.0));
}
float leaderSeconds(int kind, float radiusKm, float seed) {
${kindLines((k, kind) => {
	const [climb, run] = leaderMeans(kind);
	return `\tif (kind == ${kind}) return clamp(length(vec2(${f(climb)}, min(${f(run)}, max(radiusKm, ${f(k.reachKm)})))) / (${f(k.leaderSpeed)} * pace(seed)), ${f(k.leaderBounds[0])}, ${f(k.leaderBounds[1])});`;
})}
	return 0.0;
}
float spreadSeconds(int kind, float radiusKm, float flicker, float seed) {
	if (isGround(kind)) return leaderSeconds(kind, radiusKm, seed);
${kindLines((k, kind) => {
	if (isGround(kind)) return null;
	const share = kind === FlashKind.IcCrawler ? 1 : PROFILE.cloudSpread;
	return `\tif (kind == ${kind}) return min(${f(k.runR[1] * 1000)} * radiusKm / (${f(k.spreadSpeed)} * pace(seed)), ${f(share)} * flicker);`;
})}
	return 0.0;
}
`;

/** Offset in km, east and north, of the light of an in-cloud flash `age` seconds in: it follows its leaders across the footprint. */
export function cloudDrift(age: number, flicker: number, radiusKm: number, seed: number, kind: FlashKind): [number, number] {
	if (isGround(kind)) return [0, 0];
	const along = (2 * spread(age, flicker, false) - 1) * CHANNEL.drift * radiusKm;
	const heading = channelHash(seed, 1) * 2 * Math.PI;
	return [Math.cos(heading) * along, Math.sin(heading) * along];
}

/** GLSL twin of `cloudDrift`; needs `channelGlsl` and `spread`. */
export const cloudDriftGlsl = /* glsl */ `
vec2 cloudDrift(float age, float len, float radiusKm, float seed, int kind) {
	if (isGround(kind)) return vec2(0.0);
	float heading = channelHash(seed, 1.0) * 6.2831853;
	return vec2(cos(heading), sin(heading)) * (2.0 * spread(age, len, false) - 1.0) * ${f(CHANNEL.drift)} * radiusKm;
}
`;
