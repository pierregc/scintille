import { glslFloat as f } from './profile';

/** Thin lightning channel drawn over the glow while a flash flickers; see docs/flash-profile.md. */
export const CHANNEL = {
	/** Channel half-length relative to the flash radius, and its floor in pixels so shapes stay readable from far. */
	lengthScale: 2.2,
	minPixels: 6,
	/** Flash radii (km) over which shapes shift from I and zigzag to Y and branched. */
	smallKm: 4,
	largeKm: 14,
	/** The channel fades out this long after the flicker phase, seconds. */
	fade: 0.15,
	/** Branches only light on the first pulse: their decay constant, seconds. */
	branchTau: 0.06,
	/** Share of the glow held back while the channel shows, so the cloud does not wash it out. */
	glowDip: 0.6,
} as const;

/** Shape of a flash, 0 I, 1 zigzag, 2 Y, 3 branched: small flashes lean to I and zigzag, large ones to Y and branched. */
export function channelShape(radiusKm: number, seed: number): number {
	const t = Math.min(1, Math.max(0, (radiusKm - CHANNEL.smallKm) / (CHANNEL.largeKm - CHANNEL.smallKm)));
	return Math.min(3, Math.floor((seed * 0.6 + t * 0.4) * 4));
}

/** Per-flash hash in [0, 1) for draw `k`, so each shape detail is independent. */
export function channelHash(seed: number, k: number): number {
	const x = Math.sin(seed * 78.233 + k * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

/** GLSL twins of `channelShape` and `channelHash`, plus the channel light. */
export const channelGlsl = /* glsl */ `
float channelShape(float radiusKm, float seed) {
	float t = clamp((radiusKm - ${f(CHANNEL.smallKm)}) / ${f(CHANNEL.largeKm - CHANNEL.smallKm)}, 0.0, 1.0);
	return min(3.0, floor((seed * 0.6 + t * 0.4) * 4.0));
}
float channelHash(float seed, float k) {
	return fract(sin(seed * 78.233 + k * 12.9898) * 43758.5453);
}
float segment(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a;
	vec2 ba = b - a;
	return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
float line(float d, float width) {
	return exp(-d * d / (width * width)) + 0.15 * exp(-d * 0.7);
}
vec2 mainPoint(float i, float seed, float shape) {
	float end = shape == 2.0 ? 0.1 : 1.0;
	float zig = shape == 1.0 ? (mod(i, 2.0) - 0.5) * (0.1 + 0.2 * channelHash(seed, 60.0 + i)) : 0.0;
	float amp = shape == 1.0 ? 0.12 : 0.06;
	float y = i == 0.0 ? 0.0 : (channelHash(seed, i) - 0.5) * 2.0 * amp + zig;
	return vec2(mix(-1.0, end, i / 7.0), y);
}
// Light of the main channel and its branches at p, in channel half-lengths, with pixels per half-length.
float channelLight(vec2 p, float seed, float shape, float pixels, float branchLevel) {
	float main = 0.0;
	vec2 a = mainPoint(0.0, seed, shape);
	for (int i = 1; i <= 7; i++) {
		vec2 b = mainPoint(float(i), seed, shape);
		main = max(main, line(segment(p, a, b) * pixels, 0.8));
		a = b;
	}
	if (shape < 2.0 || branchLevel < 0.01) return main;
	float branches = 0.0;
	float side = channelHash(seed, 7.0) < 0.5 ? 1.0 : -1.0;
	for (int j = 0; j < 3; j++) {
		float k = float(j);
		if (shape == 2.0 && j == 2) break;
		float s = side * (mod(k, 2.0) == 0.0 ? 1.0 : -1.0);
		vec2 o = mainPoint(shape == 2.0 ? 7.0 : 1.0 + k * 2.0 + step(0.5, channelHash(seed, 20.0 + k)), seed, shape);
		float angle = s * (shape == 2.0 ? 0.3 + 0.35 * channelHash(seed, 30.0 + k) : 0.5 + 0.6 * channelHash(seed, 30.0 + k));
		float len = shape == 2.0 ? 0.95 : 0.3 + 0.35 * channelHash(seed, 40.0 + k);
		vec2 dir = vec2(cos(angle), sin(angle));
		vec2 normal = vec2(-dir.y, dir.x);
		vec2 c = o;
		for (int m = 1; m <= 4; m++) {
			float q = float(m);
			vec2 d = o + dir * len * q / 4.0 + normal * (channelHash(seed, 50.0 + k * 5.0 + q) - 0.5) * 0.25 * len;
			float taper = shape == 2.0 ? 1.0 : 1.1 - 0.2 * q;
			branches = max(branches, taper * line(segment(p, c, d) * pixels, 0.6));
			c = d;
		}
	}
	return max(main, branchLevel * 0.7 * branches);
}
`;
