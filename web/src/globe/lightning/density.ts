import { channelHash } from './channel';
import { glslFloat as f } from './profile';

/**
 * How many flashes a storm view draws in full at each replay speed; see docs/flash-profile.md.
 * Every flash lights the cloud; channels, the near-floor sprite, halos and sound go to a sample
 * picked by a fixed seed, so a revisit shows the same flashes.
 */
export const DENSITY = {
	/** Flashes within their flicker at once, by replay speed; between the keys the target follows a power law of the speed. */
	targets: { 1: Infinity, 60: 50, 600: 20, 3600: 8 } as Record<number, number>,
	/** Bands the targets were tuned in, for the same speeds. */
	band: { 60: [30, 100], 600: [12, 30], 3600: [5, 12] } as Record<number, readonly [number, number]>,
	/** Wall clock seconds of flashes counted as alive when sizing the sample: about a flicker and its fade. */
	aliveWindow: 0.4,
	/** Lot weight of the strongest flash, against 1 for the weakest: stronger flashes are up to 2.5× likelier. */
	energyWeight: 0.4,
	/** Mean of the energy weight over the flashes, so `share × alive × meanWeight ≈ target`. */
	meanWeight: 1.5,
	/** Time constant of the applied share, wall clock seconds; a seek or a speed change applies it at once. */
	smoothing: 2,
	/** A flash fades out over this factor of the share instead of popping at its edge. */
	edge: 1.1,
	/** Sprite kept by the flashes outside the sample when the cloud light has no surface to show them. */
	weakGlow: 0.5,
	/** Newest flashes the cloud light keeps in a storm view; Infinity keeps every flash (the bench needed no ceiling). */
	lightMapCeiling: Infinity,
} as const;

const SPEEDS = Object.keys(DENSITY.targets).map(Number).sort((a, b) => a - b);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};

/** Flashes within their flicker at once wanted at a replay `speed`; Infinity draws every flash. */
export function heroTarget(speed: number): number {
	const s = Math.min(Math.max(speed, SPEEDS[0]), SPEEDS[SPEEDS.length - 1]);
	let i = 1;
	while (i < SPEEDS.length - 1 && SPEEDS[i] <= s) i++;
	const [a, b] = [SPEEDS[i - 1], SPEEDS[i]];
	const [ta, tb] = [DENSITY.targets[a], DENSITY.targets[b]];
	if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
	const t = Math.log(s / a) / Math.log(b / a);
	if (t <= 0) return ta;
	if (t >= 1) return tb;
	return Math.exp(Math.log(ta) + t * (Math.log(tb) - Math.log(ta)));
}

/** Per-flash lot in [0, 1): a flash is in the sample while its lot is under the share. */
export function heroLot(seed: number, intensity: number): number {
	return channelHash(seed, 3) * (1 + (DENSITY.energyWeight - 1) * clamp01(intensity));
}

/** Share of the lots under which `target` of the `alive` flashes are drawn in full. */
export function heroShare(target: number, alive: number): number {
	return clamp01(target / (DENSITY.meanWeight * Math.max(alive, 1)));
}

/** Weight of a flash's full drawing, 1 under the share and 0 past `DENSITY.edge` times it. */
export function heroWeight(lot: number, share: number): number {
	return 1 - smoothstep(share, share * DENSITY.edge, lot);
}

/** The applied share after `dt` wall clock seconds, following `wanted` geometrically, or at once on a `jump`. */
export function followShare(current: number, wanted: number, dt: number, jump = false): number {
	if (jump || !(current > 0)) return wanted;
	const next = current * (wanted / current) ** Math.min(1, dt / DENSITY.smoothing);
	return Math.abs(next - wanted) < 1e-4 ? wanted : next;
}

/** GLSL twins of `heroLot` and `heroWeight`; needs `channelGlsl`. `heroShare` is the applied share, `lightMapOff` 1 when no cloud light shows. */
export const densityGlsl = /* glsl */ `
uniform float heroShare;
uniform float lightMapOff;
float heroLot(float seed, float intensity) {
	return channelHash(seed, 3.0) * mix(1.0, ${f(DENSITY.energyWeight)}, clamp(intensity, 0.0, 1.0));
}
float heroWeight(float lot, float share) {
	return 1.0 - smoothstep(share, share * ${f(DENSITY.edge)}, lot);
}
`;
