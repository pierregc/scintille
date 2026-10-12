/** Shape of a flash over time; mirrored in the vertex shader, see docs/flash-profile.md. */
export const PROFILE = {
	/** Flicker phase bounds, seconds of scene time. */
	minFlicker: 0.06,
	maxFlicker: 0.6,
	/** One pulse per this much flicker, at most `maxPulses`. */
	pulseEvery: 0.15,
	maxPulses: 4,
	/** Pulse decay constant, seconds, scaled per flash by up to `tauSpread` either way; each later pulse is `pulseFade` times the previous one. */
	pulseTau: 0.04,
	tauSpread: 1.6,
	pulseFade: 0.7,
	/** Afterglow level relative to the first pulse, for display windows up to `glowRef` seconds. */
	afterglow: 0.12,
	/** Longer windows dim the afterglow as `(glowRef / display) ^ glowScale`, so more flashes on screen stay readable. */
	glowRef: 300,
	glowScale: 1,
	/** Afterglow decay time constant, as a fraction of the display window. */
	glowTau: 0.25,
	/** Fall of the reduced-motion fade down to the afterglow, seconds. */
	softFall: 0.25,
	/** Rise of the reduced-motion fade, seconds, at most 4 % of the display time. */
	softRise: 0.06,
} as const;

const ATTACK = 0.004;

function smoothstep(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

/** Afterglow level for a display window of `display` seconds. */
export function glowLevel(display: number): number {
	return PROFILE.afterglow * Math.min(1, (PROFILE.glowRef / display) ** PROFILE.glowScale);
}

/** Exponential fade over the display window, from 1 at `t` = 0 to exactly 0 at `t` = 1. */
export function glowDecay(t: number): number {
	const end = Math.exp(-1 / PROFILE.glowTau);
	return (Math.exp(-t / PROFILE.glowTau) - end) / (1 - end);
}

/** Flicker phase length in seconds for a measured flash duration in milliseconds. */
export function flickerLength(durationMs: number): number {
	return Math.min(PROFILE.maxFlicker, Math.max(PROFILE.minFlicker, durationMs / 1000));
}

/** Pulse decay constant of a flash, from its `seed`, so blinks do not share one rhythm. */
export function pulseTau(seed: number): number {
	return PROFILE.pulseTau * PROFILE.tauSpread ** ((((seed * 3.7) % 1) - 0.5) * 2);
}

export function pulseCount(flicker: number): number {
	return Math.min(PROFILE.maxPulses, 1 + Math.floor(flicker / PROFILE.pulseEvery));
}

/** Start of pulse `k`, jittered by a per-flash `seed` in [0, 1). */
export function pulseStart(k: number, n: number, flicker: number, seed: number): number {
	if (k === 0) return 0;
	const jitter = (((seed * (k + 1) * 7.13) % 1) - 0.5) * 0.4;
	return (flicker * (k + jitter)) / n;
}

/**
 * Brightness in [0, 1] of a flash `age` seconds old, shown for `display` seconds.
 * `flicker` false gives the soft single fade used for reduced motion.
 */
export function flashProfile(age: number, display: number, durationMs: number, seed: number, flicker = true): number {
	if (age < 0 || age > display) return 0;
	const glow = glowLevel(display) * glowDecay(age / display);
	if (!flicker) return smoothstep(0, Math.min(PROFILE.softRise, display * 0.04), age) * Math.max(Math.exp(-age / PROFILE.softFall), glow);
	const length = Math.min(flickerLength(durationMs), display * 0.6);
	const n = pulseCount(length);
	const tau = pulseTau(seed);
	let b = 0;
	for (let k = 0; k < n; k++) {
		const a = age - pulseStart(k, n, length, seed);
		if (a >= 0) b = Math.max(b, PROFILE.pulseFade ** k * smoothstep(0, ATTACK, a) * Math.exp(-a / tau));
	}
	return Math.max(b, glow * smoothstep(0, length, age));
}

/** GLSL float literal: GLSL ES has no implicit int to float conversion. */
export const glslFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

const f = glslFloat;

/** GLSL twin of `flashProfile`, with `seed`, `durationMs` and `flicker` as inputs. */
export const flashProfileGlsl = /* glsl */ `
float flashProfile(float age, float display, float durationMs, float seed, float flicker) {
	if (age < 0.0 || age > display) return 0.0;
	float end = exp(${f(-1 / PROFILE.glowTau)});
	float glow = ${f(PROFILE.afterglow)} * min(1.0, pow(${f(PROFILE.glowRef)} / display, ${f(PROFILE.glowScale)}))
		* (exp(-age / display / ${f(PROFILE.glowTau)}) - end) / (1.0 - end);
	if (flicker < 0.5) return smoothstep(0.0, min(${f(PROFILE.softRise)}, display * 0.04), age) * max(exp(-age / ${f(PROFILE.softFall)}), glow);
	float len = min(clamp(durationMs / 1000.0, ${f(PROFILE.minFlicker)}, ${f(PROFILE.maxFlicker)}), display * 0.6);
	float n = min(${f(PROFILE.maxPulses)}, 1.0 + floor(len / ${f(PROFILE.pulseEvery)}));
	float tau = ${f(PROFILE.pulseTau)} * pow(${f(PROFILE.tauSpread)}, (fract(seed * 3.7) - 0.5) * 2.0);
	float b = 0.0;
	for (int i = 0; i < ${PROFILE.maxPulses}; i++) {
		float k = float(i);
		if (k >= n) break;
		float start = i == 0 ? 0.0 : len * (k + (fract(seed * (k + 1.0) * 7.13) - 0.5) * 0.4) / n;
		float a = age - start;
		if (a >= 0.0) b = max(b, pow(${f(PROFILE.pulseFade)}, k) * smoothstep(0.0, ${f(ATTACK)}, a) * exp(-a / tau));
	}
	return max(b, glow * smoothstep(0.0, len, age));
}
`;
