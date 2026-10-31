import { glslFloat, spread } from './profile';

/** Thin lightning channel drawn over the glow while a flash flickers; see docs/flash-profile.md. */
export const CHANNEL = {
	/** Channel half-length relative to the flash radius, always physical. */
	lengthScale: 2.2,
	/** Share of cloud-to-ground looks: a rendering choice, not a satellite classification. */
	groundShare: 0.25,
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
	glowDip: 0.8,
	haloGlowDip: 0.9,
	cloudGlowDip: 0.85,
	/** Share of the glow left near the floor over sunlit clouds, where nothing of a flash shows from orbit. */
	glowDayLevel: 0.35,
	haloCapacity: 256,
	haloFadeStartKm: 1500,
	haloFadeEndKm: 6000,
} as const;

/** Per-flash seed in [0, 1) from its event time (UTC ms) and position, stable across rebases and revisits. */
export function flashSeed(timeMs: number, lat: number, lon: number): number {
	return channelHash((timeMs % 86_400_000) + lat * 100 + lon, 0);
}

/** Cloud-to-ground look, a rendering choice drawn from the seed for `groundShare` of flashes. */
export function isGround(seed: number): boolean {
	return channelHash(seed, 2) < CHANNEL.groundShare;
}

/** Per-flash hash in [0, 1) for draw `k`, so each shape detail is independent. */
export function channelHash(seed: number, k: number): number {
	const x = Math.sin(seed * 78.233 + k * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

/** GLSL twins of the per-flash hash and of `isGround`. */
export const channelGlsl = /* glsl */ `
float channelHash(float seed, float k) {
	return fract(sin(seed * 78.233 + k * 12.9898) * 43758.5453);
}
bool isGround(float seed) {
	return channelHash(seed, 2.0) < ${glslFloat(CHANNEL.groundShare)};
}
`;

/** Offset in km, east and north, of the light of an in-cloud flash `age` seconds in: it follows its leaders across the footprint. */
export function cloudDrift(age: number, flicker: number, radiusKm: number, seed: number): [number, number] {
	if (isGround(seed)) return [0, 0];
	const along = (2 * spread(age, flicker, false) - 1) * CHANNEL.drift * radiusKm;
	const heading = channelHash(seed, 1) * 2 * Math.PI;
	return [Math.cos(heading) * along, Math.sin(heading) * along];
}

/** GLSL twin of `cloudDrift`; needs `channelGlsl` and `spread`. */
export const cloudDriftGlsl = /* glsl */ `
vec2 cloudDrift(float age, float len, float radiusKm, float seed, bool ground) {
	if (ground) return vec2(0.0);
	float heading = channelHash(seed, 1.0) * 6.2831853;
	return vec2(cos(heading), sin(heading)) * (2.0 * spread(age, len, false) - 1.0) * ${glslFloat(CHANNEL.drift)} * radiusKm;
}
`;
