/** How far the styled field strays from the observations (ADR 0031), over square blocks of ground. */
export interface StyleBounds {
	/** Blocks compared: heights known and some cloud in them. */
	blocks: number;
	/** Mean of the blocks' absolute differences in cover (0 to 1). */
	meanAbs: number;
	/** Largest absolute difference of one block. */
	maxAbs: number;
	/** Mean signed difference, styled minus observed. */
	bias: number;
	/** Largest change of an opaque top (km), where the observed top is reliable. */
	maxTopKm: number;
	/** Mean drawn opacity straight down minus the observed cover, over the same blocks: the eased cap. */
	drawnBias: number;
	/** Share of semi-transparent texels whose top was lifted more than 1 km, and the largest lift (km). */
	liftedShare: number;
	maxLiftKm: number;
}

/** Opacity of the densest column seen straight down, and the cover up to which a column is drawn as observed (ADR 0031). */
export const VOLUME_MAX_OPACITY = 0.95;
export const VOLUME_KNEE = 0.5;
/** Opacity of the densest cloud over a flash, lower so flashes show through (ADR 0031). */
export const VEIL_MAX_OPACITY = 0.8;

/** Opacity for a cover: as observed up to the knee, then eased to the cap (twin of the shaders' `easeOpacity`). */
export function capOpacity(cover: number, cap = VOLUME_MAX_OPACITY, knee = VOLUME_KNEE): number {
	const a = Math.min(1, Math.max(0, cover));
	return a <= knee ? a : knee + ((a - knee) * (cap - knee)) / (1 - knee);
}

const OPAQUE = 0.98;
const CLEAR = 0.02;

/**
 * Compares two windows of `size`² texels laid out as the field bake writes them (cover, top / 20 km, core,
 * heights known, each 0 to 1): the observations and their styling, over blocks of `blockKm`.
 */
export function styleBounds(observed: Float32Array, styled: Float32Array, size: number, texelKm: number, blockKm = 4): StyleBounds {
	const block = Math.max(1, Math.round(blockKm / texelKm));
	const diffs: number[] = [];
	const drawn: number[] = [];
	let maxTopKm = 0;
	let semi = 0;
	let lifted = 0;
	let maxLiftKm = 0;
	for (let by = 0; by + block <= size; by += block) {
		for (let bx = 0; bx + block <= size; bx += block) {
			let known = 0;
			let seen = 0;
			let made = 0;
			let shown = 0;
			for (let y = by; y < by + block; y++) {
				for (let x = bx; x < bx + block; x++) {
					const i = (y * size + x) * 4;
					if (observed[i + 3] < 0.5 || styled[i + 3] < 0.5) continue;
					known++;
					const a = observed[i];
					seen += a;
					made += styled[i];
					shown += capOpacity(styled[i]);
					const change = (styled[i + 1] - observed[i + 1]) * 20;
					if (a >= OPAQUE) maxTopKm = Math.max(maxTopKm, Math.abs(change));
					else if (a > CLEAR) {
						semi++;
						if (change > 1) lifted++;
						maxLiftKm = Math.max(maxLiftKm, change);
					}
				}
			}
			if (known < (block * block) / 2) continue;
			seen /= known;
			made /= known;
			if (seen < CLEAR && made < CLEAR) continue;
			diffs.push(made - seen);
			drawn.push(shown / known - seen);
		}
	}
	const lifts = { liftedShare: semi > 0 ? lifted / semi : 0, maxLiftKm };
	if (diffs.length === 0) return { blocks: 0, meanAbs: 0, maxAbs: 0, bias: 0, maxTopKm, drawnBias: 0, ...lifts };
	const abs = diffs.map(Math.abs);
	const mean = (values: number[]) => values.reduce((s, d) => s + d, 0) / values.length;
	return {
		blocks: diffs.length,
		meanAbs: mean(abs),
		maxAbs: Math.max(...abs),
		bias: mean(diffs),
		maxTopKm,
		drawnBias: mean(drawn),
		...lifts,
	};
}
