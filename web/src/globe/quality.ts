export type QualityTier = 'low' | 'medium' | 'high';
export const TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

export interface QualityPreset {
	/** Earth texture folder. */
	textures: '2k' | '4k' | '8k';
	/** Device pixel ratio cap. */
	maxPixelRatio: number;
	/** Flashes kept on the GPU; null keeps the whole live window. */
	maxFlashes: number | null;
	/** Clouds lit from inside by flashes (#64). */
	cloudLight: boolean;
	/** Live cloud texture tier. */
	clouds: '2k' | '4k';
	/** Bicubic cloud filtering. */
	cloudBicubic: boolean;
	/** Finer cloud tiles near the camera. */
	cloudDetail: boolean;
	/** Bloom and grading (#58). */
	postProcessing: boolean;
	/** GPU memory for surface detail tiles (ADR 0022), MB. */
	surfaceMb: number;
	/** Clouds in relief near the ground (ADR 0028): march resolution as a share of the CSS size, 0 for the flat layer. */
	cloudVolume: number;
}

/** What each tier turns on; later visual features add their own line here. */
export const PRESETS: Record<QualityTier, QualityPreset> = {
	low: { textures: '2k', maxPixelRatio: 1, maxFlashes: 1 << 16, clouds: '2k', cloudLight: false, cloudBicubic: false, cloudDetail: false, postProcessing: false, surfaceMb: 0, cloudVolume: 0 },
	medium: { textures: '4k', maxPixelRatio: 1.5, maxFlashes: null, clouds: '4k', cloudLight: true, cloudBicubic: true, cloudDetail: true, postProcessing: false, surfaceMb: 96, cloudVolume: 0.4 },
	high: { textures: '4k', maxPixelRatio: 2, maxFlashes: null, clouds: '4k', cloudLight: true, cloudBicubic: true, cloudDetail: true, postProcessing: true, surfaceMb: 96, cloudVolume: 0.5 },
};

export interface DeviceHints {
	/** Unmasked WebGL renderer string, when the browser exposes it. */
	gpu?: string;
	/** Shortest screen side, CSS pixels. */
	screenMin: number;
	coarsePointer: boolean;
	/** `navigator.deviceMemory`, GB, when available. */
	memoryGb?: number;
}

const WEAK_GPU = /mali|adreno \(tm\) [1-5]\d\d|powervr|intel\(r\) (hd|uhd) graphics|swiftshader|llvmpipe/i;
const STRONG_GPU = /apple m\d|nvidia|geforce|rtx|radeon (rx|pro)|apple gpu/i;

/** Phones have 256 MB for the whole scene instead of 384 (ADR 0020); the globe takes about 205. */
export const PHONE_SURFACE_MB = 40;

export function isPhone({ screenMin, coarsePointer }: DeviceHints): boolean {
	return coarsePointer && screenMin < 600;
}

export function surfaceBudgetMb(tier: QualityTier, phone: boolean): number {
	return Math.min(PRESETS[tier].surfaceMb, phone ? PHONE_SURFACE_MB : Infinity);
}

/** Initial tier from cheap hints: phones and weak GPUs start low, known strong GPUs high. */
export function guessTier({ gpu = '', screenMin, coarsePointer, memoryGb }: DeviceHints): QualityTier {
	if (WEAK_GPU.test(gpu) || (memoryGb !== undefined && memoryGb <= 2)) return 'low';
	if (isPhone({ screenMin, coarsePointer })) return STRONG_GPU.test(gpu) ? 'medium' : 'low';
	if (STRONG_GPU.test(gpu)) return 'high';
	return 'medium';
}

/** `?quality=low|medium|high`, for testing. */
export function tierFromSearch(search: string): QualityTier | null {
	const value = new URLSearchParams(search).get('quality');
	return TIERS.includes(value as QualityTier) ? (value as QualityTier) : null;
}

export function lowerTier(tier: QualityTier): QualityTier {
	return TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];
}

/**
 * Watches frame times and asks for one tier down when the average frame rate stays under
 * `minFps` for `windowMs`; waits `cooldownMs` after each downgrade. Never upgrades.
 */
export class FpsMonitor {
	readonly #minFps: number;
	readonly #windowMs: number;
	readonly #cooldownMs: number;
	#start = Number.NaN;
	#frames = 0;
	#lastDowngrade = Number.NEGATIVE_INFINITY;

	constructor({ minFps = 30, windowMs = 5000, cooldownMs = 10_000 } = {}) {
		this.#minFps = minFps;
		this.#windowMs = windowMs;
		this.#cooldownMs = cooldownMs;
	}

	/** Call once per frame with a monotonic time (ms); returns true when a downgrade is due. */
	frame(now: number): boolean {
		if (Number.isNaN(this.#start) || isHiddenGap(now - this.#start, this.#windowMs)) {
			this.#start = now;
			this.#frames = 0;
			return false;
		}
		this.#frames++;
		const elapsed = now - this.#start;
		if (elapsed < this.#windowMs) return false;
		const fps = (this.#frames * 1000) / elapsed;
		this.#start = now;
		this.#frames = 0;
		if (fps >= this.#minFps || now - this.#lastDowngrade < this.#cooldownMs) return false;
		this.#lastDowngrade = now;
		return true;
	}
}

/** A window far longer than expected means the tab was hidden; it says nothing about speed. */
function isHiddenGap(elapsed: number, windowMs: number): boolean {
	return elapsed > windowMs * 3;
}
