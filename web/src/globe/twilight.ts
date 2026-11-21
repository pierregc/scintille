/** Sun elevations (degrees) bounding sunset and civil, nautical and astronomical twilight. */
export const TWILIGHT_ELEVATIONS = [0, -6, -12, -18] as const;

/** Light kept by each band edge; sums to 1 so full day is 1 and full night 0. */
export const TWILIGHT_WEIGHTS = [0.5, 0.25, 0.15, 0.1] as const;

/** Half-width (degrees) of the smooth transition around each band edge. */
export const TWILIGHT_SOFTNESS_DEG = 2;

/** Soft cool light over the night side, so land and clouds stay readable without dimming the flashes. */
export const MOONLIGHT = { tint: [0.55, 0.68, 1.0], ground: 0.1, clouds: 0.028 } as const;

/** Night light on the cloud tops, linear RGB, shared by the flat layer and the volume. */
export const MOON_CLOUD_COLOR = MOONLIGHT.tint.map((c) => c * MOONLIGHT.clouds);

const DEG = Math.PI / 180;

export type Vec4 = [number, number, number, number];

export interface TwilightUniforms {
	/** sin(elevation) of each band edge, as compared in the shader with dot(normal, sun). */
	edges: Vec4;
	weights: Vec4;
	/** Transition half-width in sin(elevation) units. */
	softness: number;
}

export function twilightUniforms(): TwilightUniforms {
	return {
		edges: TWILIGHT_ELEVATIONS.map((e) => Math.sin(e * DEG)) as Vec4,
		weights: [...TWILIGHT_WEIGHTS],
		softness: Math.sin(TWILIGHT_SOFTNESS_DEG * DEG),
	};
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/** Daylight level in [0, 1] at a sun elevation; mirrors `twilight()` in the Earth shader. */
export function twilightLevel(elevationDeg: number, u: TwilightUniforms = twilightUniforms()): number {
	const s = Math.sin(elevationDeg * DEG);
	return u.edges.reduce(
		(level, edge, i) => level + u.weights[i] * smoothstep(edge - u.softness, edge + u.softness, s),
		0,
	);
}
