/** Thin lightning channel drawn over the glow while a flash flickers; see docs/flash-profile.md. */
export const CHANNEL = {
	/** Channel half-length relative to the flash radius, and its floor in pixels so shapes stay readable from far. */
	lengthScale: 2.2,
	minPixels: 6,
	/** The channel fades out this long after the flicker phase, seconds. */
	fade: 0.15,
	/** Branches only light on the first pulse: their decay constant, seconds. */
	branchTau: 0.06,
	/** Share of the glow held back while the channel shows, so the cloud does not wash it out. */
	glowDip: 0.6,
} as const;

/** Per-flash hash in [0, 1) for draw `k`, so each shape detail is independent. */
export function channelHash(seed: number, k: number): number {
	const x = Math.sin(seed * 78.233 + k * 12.9898) * 43758.5453;
	return x - Math.floor(x);
}

/** GLSL twin of the per-flash hash. */
export const channelGlsl = /* glsl */ `
float channelHash(float seed, float k) {
	return fract(sin(seed * 78.233 + k * 12.9898) * 43758.5453);
}
`;
