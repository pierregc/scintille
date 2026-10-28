/** Shape of a flash over time; mirrored in the shaders, see docs/flash-profile.md. */
export const PROFILE = {
	/** Flicker phase bounds, seconds of wall clock time: the observed duration, clamped. */
	minFlicker: 0.06,
	maxFlicker: 1,
	/** Gap between pulses, seconds: `pulseGap` at the median, from `minGap` to `maxGap`, as between strokes. */
	pulseGap: 0.06,
	minGap: 0.01,
	maxGap: 0.2,
	maxPulses: 12,
	/** Pulse decay constant, seconds, picked per pulse between these bounds. */
	minTau: 0.015,
	maxTau: 0.06,
	/** Level of each pulse after the first, picked between these bounds. */
	minLevel: 0.3,
	maxLevel: 0.9,
	/** Pulses are averaged over one frame at 60 Hz, like a shutter, so none falls between two frames. */
	shutter: 1 / 60,
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

function smoothstep(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

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

/** Gap before pulse `k`, seconds: log-triangular around `pulseGap`. */
export function pulseGap(seed: number, k: number): number {
	const t = pulseHash(seed, 10 + k) + pulseHash(seed, 30 + k) - 1;
	const span = t >= 0 ? PROFILE.maxGap / PROFILE.pulseGap : PROFILE.pulseGap / PROFILE.minGap;
	return PROFILE.pulseGap * span ** t;
}

export function pulseTau(seed: number, k: number): number {
	return PROFILE.minTau * (PROFILE.maxTau / PROFILE.minTau) ** pulseHash(seed, 50 + k);
}

export function pulseLevel(seed: number, k: number): number {
	return k === 0 ? 1 : PROFILE.minLevel + (PROFILE.maxLevel - PROFILE.minLevel) * pulseHash(seed, 70 + k);
}

/** Start of each pulse within a flicker phase of `flicker` seconds. */
export function pulseStarts(flicker: number, seed: number): number[] {
	const starts = [0];
	for (let k = 1; k < PROFILE.maxPulses; k++) {
		const start = starts[k - 1] + pulseGap(seed, k);
		if (start > flicker) break;
		starts.push(start);
	}
	return starts;
}

/** Mean over the last shutter time of a pulse that started `a` seconds ago and decays with `tau`. */
function shutterPulse(a: number, tau: number): number {
	if (a <= 0) return 0;
	return (tau / PROFILE.shutter) * (Math.exp(-Math.max(a - PROFILE.shutter, 0) / tau) - Math.exp(-a / tau));
}

/**
 * Brightness in [0, 1] of a flash `wallAge` seconds of wall clock time after it started, `sceneAge`
 * seconds of scene time, with an afterglow of `display` seconds of scene time (0 for none).
 * `flicker` false gives the soft single fade used for reduced motion.
 */
export function flashProfile(
	wallAge: number,
	sceneAge: number,
	display: number,
	durationMs: number,
	seed: number,
	flicker = true,
): number {
	if (sceneAge < 0 || wallAge < 0) return 0;
	const length = flickerLength(durationMs);
	const life = flashLife(length);
	let glow = display > 0 && sceneAge <= display ? glowLevel(display) * glowDecay(sceneAge / display) : 0;
	if (wallAge > life) return glow;
	glow = Math.max(glow, PROFILE.afterglow * glowDecay(wallAge / life));
	if (!flicker) return smoothstep(0, PROFILE.softRise, wallAge) * Math.max(Math.exp(-wallAge / PROFILE.softFall), glow);
	let b = 0;
	let start = 0;
	for (let k = 0; k < PROFILE.maxPulses; k++) {
		if (k > 0) start += pulseGap(seed, k);
		if (start > length || start > wallAge) break;
		b = Math.max(b, pulseLevel(seed, k) * shutterPulse(wallAge - start, pulseTau(seed, k)));
	}
	return Math.max(b, glow * smoothstep(0, length, wallAge));
}

/** GLSL float literal: GLSL ES has no implicit int to float conversion. */
export const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

const f = glslFloat;
const P = PROFILE;

/** GLSL twin of `flashProfile`. */
export const flashProfileGlsl = /* glsl */ `
float pulseHash(float seed, float k) {
	return fract(sin(seed * 91.345 + k * 47.853) * 43758.5453);
}
float glowDecay(float t) {
	float end = exp(${f(-1 / P.glowTau)});
	return (exp(-t / ${f(P.glowTau)}) - end) / (1.0 - end);
}
float flashProfile(float wallAge, float sceneAge, float display, float durationMs, float seed, float flicker) {
	if (sceneAge < 0.0 || wallAge < 0.0) return 0.0;
	float len = clamp(durationMs / 1000.0, ${f(P.minFlicker)}, ${f(P.maxFlicker)});
	float life = max(${f(P.life)}, len + ${f(P.tail)});
	float glow = display > 0.0 && sceneAge <= display
		? ${f(P.afterglow)} * min(1.0, pow(${f(P.glowRef)} / display, ${f(P.glowScale)})) * glowDecay(sceneAge / display)
		: 0.0;
	if (wallAge > life) return glow;
	glow = max(glow, ${f(P.afterglow)} * glowDecay(wallAge / life));
	if (flicker < 0.5) return smoothstep(0.0, ${f(P.softRise)}, wallAge) * max(exp(-wallAge / ${f(P.softFall)}), glow);
	float b = 0.0;
	float start = 0.0;
	for (int i = 0; i < ${P.maxPulses}; i++) {
		float k = float(i);
		if (i > 0) {
			float t = pulseHash(seed, 10.0 + k) + pulseHash(seed, 30.0 + k) - 1.0;
			start += ${f(P.pulseGap)} * pow(t >= 0.0 ? ${f(P.maxGap / P.pulseGap)} : ${f(P.pulseGap / P.minGap)}, t);
		}
		if (start > len || start > wallAge) break;
		float a = wallAge - start;
		float tau = ${f(P.minTau)} * pow(${f(P.maxTau / P.minTau)}, pulseHash(seed, 50.0 + k));
		float level = i == 0 ? 1.0 : ${f(P.minLevel)} + ${f(P.maxLevel - P.minLevel)} * pulseHash(seed, 70.0 + k);
		b = max(b, level * tau / ${f(P.shutter)} * (exp(-max(a - ${f(P.shutter)}, 0.0) / tau) - exp(-a / tau)));
	}
	return max(b, glow * smoothstep(0.0, len, wallAge));
}
`;
