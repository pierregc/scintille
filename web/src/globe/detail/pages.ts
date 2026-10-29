import type { TileKey } from './pyramid';

/** Where one layer of an area takes its texels: a layer of the tile array, at a pyramid level. */
export interface PageSource {
	layer: number;
	z: number;
}

export interface PagePatch {
	key: TileKey;
	day?: PageSource;
	night?: PageSource;
}

export const PAGE_FADE_MS = 400;
const BASE = 0;
const LAYERS = 2;

const code = ({ layer, z }: PageSource) => (layer << 4) | z;

/**
 * Page table of the surface detail, one cell per tile of the finest level. For day and night, each
 * cell names the tile shown and the one it fades from; level 0 is the global texture. Cell (x, y)
 * of layer l is texel (2 x + l, y), rows from the south: R shown layer, G faded layer, B shown
 * level + 16 × faded level, A fade.
 */
export class SurfacePages {
	readonly data: Uint8Array;
	#target: Uint16Array[];
	#shown: Uint16Array[];
	#from: Uint16Array[];
	#since: Float64Array[];
	#fading = 0;
	#detailed = 0;
	#signature = Number.NaN;
	#dirty = false;

	constructor(readonly columns: number, readonly rows: number, readonly finest: number, private readonly fadeMs = PAGE_FADE_MS) {
		const cells = columns * rows;
		this.data = new Uint8Array(cells * LAYERS * 4);
		this.#target = [0, 1].map(() => new Uint16Array(cells));
		this.#shown = [0, 1].map(() => new Uint16Array(cells));
		this.#from = [0, 1].map(() => new Uint16Array(cells));
		this.#since = [0, 1].map(() => new Float64Array(cells));
		this.#reset();
	}

	/** Whether any cell shows or fades from a tile. */
	get active(): boolean {
		return this.#detailed > 0 || this.#fading > 0;
	}

	/** Paints the patches, coarse first, and fades every cell whose source changed; true when `data` changed since the last call. */
	update(patches: readonly PagePatch[], now: number): boolean {
		const signature = this.#sign(patches);
		if (signature === this.#signature && this.#fading === 0) return false;
		this.#signature = signature;
		for (const target of this.#target) target.fill(BASE);
		for (const patch of [...patches].sort((a, b) => a.key.z - b.key.z)) this.#paint(patch);

		let changed = this.#dirty;
		this.#dirty = false;
		this.#fading = 0;
		this.#detailed = 0;
		for (let l = 0; l < LAYERS; l++) {
			const target = this.#target[l];
			const shown = this.#shown[l];
			const from = this.#from[l];
			const since = this.#since[l];
			for (let i = 0; i < target.length; i++) {
				if (target[i] !== shown[i]) {
					// A fade still mostly showing its start keeps that start.
					if (from[i] === shown[i] || this.#progress(since[i], now) >= 0.5) from[i] = shown[i];
					shown[i] = target[i];
					since[i] = now;
					this.#write(l, i, from[i] === shown[i] ? 1 : 0);
					changed = true;
				} else if (from[i] !== shown[i]) {
					const progress = this.#progress(since[i], now);
					if (progress >= 1) from[i] = shown[i];
					this.#write(l, i, progress);
					changed = true;
				}
				if (from[i] !== shown[i]) this.#fading++;
				if (shown[i] !== BASE) this.#detailed++;
			}
		}
		return changed;
	}

	/** Drops every reference to a texture layer about to hold another tile: its cells show the global texture. */
	release(layer: number): void {
		const uses = (value: number) => value !== BASE && value >> 4 === layer;
		for (let l = 0; l < LAYERS; l++) {
			const shown = this.#shown[l];
			const from = this.#from[l];
			for (let i = 0; i < shown.length; i++) {
				if (!uses(shown[i]) && !uses(from[i])) continue;
				if (uses(shown[i])) shown[i] = BASE;
				from[i] = shown[i];
				this.#write(l, i, 1);
				this.#dirty = true;
			}
		}
		this.#signature = Number.NaN;
	}

	/** Back to the global textures everywhere, at once. */
	clear(): void {
		this.#reset();
	}

	#reset() {
		for (let l = 0; l < LAYERS; l++) {
			this.#shown[l].fill(BASE);
			this.#from[l].fill(BASE);
		}
		this.data.fill(0);
		for (let a = 3; a < this.data.length; a += 4) this.data[a] = 255;
		this.#fading = 0;
		this.#detailed = 0;
		this.#signature = Number.NaN;
		this.#dirty = true;
	}

	#progress(since: number, now: number): number {
		return Math.min(Math.max((now - since) / this.fadeMs, 0), 1);
	}

	#paint({ key, day, night }: PagePatch) {
		const shift = this.finest - key.z;
		if (shift < 0) return;
		const n = 1 << shift;
		const x0 = key.x << shift;
		const y0 = key.y << shift;
		for (const [l, source] of [[0, day], [1, night]] as const) {
			if (!source) continue;
			const value = code(source);
			const target = this.#target[l];
			for (let dy = 0; dy < n; dy++) {
				const row = (this.rows - 1 - (y0 + dy)) * this.columns;
				target.fill(value, row + x0, row + x0 + n);
			}
		}
	}

	#write(l: number, cell: number, progress: number) {
		const shown = this.#shown[l][cell];
		const from = this.#from[l][cell];
		const o = (cell * LAYERS + l) * 4;
		this.data[o] = shown >> 4;
		this.data[o + 1] = from >> 4;
		this.data[o + 2] = (shown & 15) | ((from & 15) << 4);
		this.data[o + 3] = Math.round(progress * 255);
	}

	#sign(patches: readonly PagePatch[]): number {
		let hash = 2166136261;
		const mix = (value: number) => {
			hash = Math.imul(hash ^ value, 16777619);
		};
		for (const { key, day, night } of patches) {
			mix((key.z << 24) | (key.y << 12) | key.x);
			mix(day ? code(day) + 1 : 0);
			mix(night ? code(night) + 1 : 0);
		}
		return (hash >>> 0) + patches.length * 2 ** 32;
	}
}
