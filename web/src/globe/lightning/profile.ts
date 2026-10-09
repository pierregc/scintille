/** Shape of a flash over time; mirrored in the vertex shader, see docs/flash-profile.md. */
export const PROFILE = {
	/** Flicker phase bounds, seconds of scene time. */
	minFlicker: 0.06,
	maxFlicker: 0.6,
	/** One pulse per this much flicker, at most `maxPulses`. */
	pulseEvery: 0.15,
	maxPulses: 4,
	/** Pulse decay constant, seconds; each later pulse is `pulseFade` times the previous one. */
	pulseTau: 0.04,
	pulseFade: 0.7,
	/** Afterglow level relative to the first pulse. */
	afterglow: 0.18,
} as const;

const ATTACK = 0.004;

function smoothstep(a: number, b: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}

/** Flicker phase length in seconds for a measured flash duration in milliseconds. */
export function flickerLength(durationMs: number): number {
	return Math.min(PROFILE.maxFlicker, Math.max(PROFILE.minFlicker, durationMs / 1000));
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
	const t = age / display;
	if (!flicker) return smoothstep(0, 0.04, t) * (1 - t) * (1 - t);
	const length = Math.min(flickerLength(durationMs), display * 0.6);
	const n = pulseCount(length);
	let b = 0;
	for (let k = 0; k < n; k++) {
		const a = age - pulseStart(k, n, length, seed);
		if (a >= 0) b = Math.max(b, PROFILE.pulseFade ** k * smoothstep(0, ATTACK, a) * Math.exp(-a / PROFILE.pulseTau));
	}
	const glow = PROFILE.afterglow * smoothstep(0, length, age) * (1 - t) * (1 - t);
	return Math.max(b, glow);
}

/** GLSL twin of `flashProfile`, with `seed`, `durationMs` and `flicker` as inputs. */
export const flashProfileGlsl = /* glsl */ `
float flashProfile(float age, float display, float durationMs, float seed, float flicker) {
	if (age < 0.0 || age > display) return 0.0;
	float t = age / display;
	float fade = (1.0 - t) * (1.0 - t);
	if (flicker < 0.5) return smoothstep(0.0, 0.04, t) * fade;
	float len = min(clamp(durationMs / 1000.0, ${PROFILE.minFlicker}, ${PROFILE.maxFlicker}), display * 0.6);
	float n = min(${PROFILE.maxPulses}.0, 1.0 + floor(len / ${PROFILE.pulseEvery}));
	float b = 0.0;
	for (int i = 0; i < ${PROFILE.maxPulses}; i++) {
		float k = float(i);
		if (k >= n) break;
		float start = i == 0 ? 0.0 : len * (k + (fract(seed * (k + 1.0) * 7.13) - 0.5) * 0.4) / n;
		float a = age - start;
		if (a >= 0.0) b = max(b, pow(${PROFILE.pulseFade}, k) * smoothstep(0.0, ${ATTACK}, a) * exp(-a / ${PROFILE.pulseTau}));
	}
	return max(b, ${PROFILE.afterglow} * smoothstep(0.0, len, age) * fade);
}
`;
