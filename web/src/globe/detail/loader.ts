import { ancestorOf, childrenOf, keyOf, type Layer, type TileKey } from './pyramid';
import { LAYERS, type Selection } from './select';

/** Why a tile did not load: gone for good, worth retrying later, or the server asks to slow down. */
export type LoadFailure = { kind: 'missing' } | { kind: 'retry' } | { kind: 'throttled'; retryAfterMs?: number };

export class TileLoadError extends Error {
	constructor(readonly failure: LoadFailure, message: string = failure.kind) {
		super(message);
	}
}

export interface TileSource<T> {
	load(layer: Layer, key: TileKey, signal: AbortSignal): Promise<T>;
	dispose(resource: T): void;
}

export interface TileLoaderOptions {
	/** Coarsest pyramid level, and the finest level of each layer. */
	coarsest: number;
	finest: Record<Layer, number>;
	texelKm(z: number): number;
	baseTexelKm: number;
	/** GPU bytes of one tile; the cache never holds or reserves more than `maxBytes`. */
	tileBytes: number;
	maxBytes: number;
	concurrency: number;
	/** A tile is requested once wanted this long, so flights do not load what they pass through. */
	dwellMs: number;
	/** In-flight requests no longer wanted for this long are cancelled. */
	abortMs: number;
	/** Empty entries no longer wanted for this long are forgotten. */
	forgetMs: number;
	/** New textures shown per frame, to spread GPU uploads. */
	installsPerFrame: number;
	/** Request rate cap (token bucket), well under the zone limit of 300 requests per 10 s. */
	burst: number;
	perSecond: number;
	retryBaseMs: number;
	retryMaxMs: number;
	now?: () => number;
}

export const DEFAULT_LOADER: Omit<TileLoaderOptions, 'coarsest' | 'finest' | 'texelKm' | 'baseTexelKm' | 'tileBytes' | 'maxBytes'> = {
	concurrency: 6,
	dwellMs: 300,
	abortMs: 300,
	forgetMs: 5000,
	installsPerFrame: 4,
	burst: 40,
	perSecond: 8,
	retryBaseMs: 2000,
	retryMaxMs: 60_000,
};

/** Wanted-ness survives this gap between frames, so a hitch does not restart the dwell. */
const CONTINUITY_MS = 100;
/** Loaded descendants this many levels down can stand in for a wanted tile. */
const COVER_DEPTH = 2;
const THROTTLE_MS = 10_000;
const MAX_PAUSE_MS = 30_000;

type State = 'idle' | 'loading' | 'ready' | 'failed' | 'missing';

interface Slot<T> {
	layer: Layer;
	key: TileKey;
	id: string;
	state: State;
	resource?: T;
	controller?: AbortController;
	token: number;
	reserved: boolean;
	wantedSince: number;
	lastWanted: number;
	usedFrame: number;
	lastUsed: number;
	drawn: boolean;
	failures: number;
	retryAt: number;
}

export interface TileTexture<T> {
	key: TileKey;
	resource: T;
}

/** One area to draw, with the finest loaded source of each layer for it (itself or an ancestor). */
export interface Patch<T> {
	key: TileKey;
	id: string;
	day?: TileTexture<T>;
	night?: TileTexture<T>;
}

export interface TileLoaderStats {
	wanted: number;
	drawn: number;
	textures: number;
	bytes: number;
	queued: number;
	loading: number;
	requested: number;
	loaded: number;
	failed: number;
	missing: number;
	aborted: number;
	evicted: number;
	/** Loaded textures dropped without ever being drawn. */
	unused: number;
	deepest: number;
}

export interface UpdateContext {
	/** No new requests and no dwell progress, e.g. while the camera climbs. */
	hold: boolean;
	/** CSS pixels per km of texel at 1 km, to rank requests by how blurred their area looks now. */
	scale: number;
}

/**
 * Requests, caches and evicts surface tiles for the wanted selection. Requests start after the
 * dwell, by how coarse their area looks now, within the concurrency, rate and byte budgets; a tile
 * whose area its loaded descendants cover is not requested. A result is only kept if its request
 * is still the current one for that tile, so late or cancelled loads never replace anything.
 */
export class TileLoader<T> {
	#slots: Record<Layer, Map<string, Slot<T>>> = { day: new Map(), night: new Map() };
	#arrived: { slot: Slot<T>; token: number }[] = [];
	#frame = 0;
	#bytes = 0;
	#active = 0;
	#tokens: number;
	#refilled: number;
	#pausedUntil = 0;
	#errors = 0;
	#disposed = false;
	#counts = { requested: 0, loaded: 0, failed: 0, aborted: 0, evicted: 0, unused: 0 };
	#stats: TileLoaderStats;
	readonly #now: () => number;

	constructor(private readonly source: TileSource<T>, private options: TileLoaderOptions) {
		this.#now = options.now ?? (() => performance.now());
		this.#tokens = options.burst;
		this.#refilled = this.#now();
		this.#stats = this.#summary(0, 0, 0, 0);
	}

	get stats(): TileLoaderStats {
		return this.#stats;
	}

	set maxBytes(bytes: number) {
		this.options = { ...this.options, maxBytes: bytes };
	}

	isMissing(layer: Layer, key: TileKey): boolean {
		return this.#slots[layer].get(keyOf(key))?.state === 'missing';
	}

	update(selection: Selection, { hold, scale }: UpdateContext): Patch<T>[] {
		if (this.#disposed) return [];
		const now = this.#now();
		const frame = ++this.#frame;
		this.#install();

		let wanted = 0;
		for (const layer of LAYERS) {
			for (const { key, id } of selection[layer]) {
				const slot = this.#slot(layer, key, id);
				if (hold || now - slot.lastWanted > CONTINUITY_MS) slot.wantedSince = now;
				slot.lastWanted = now;
				wanted++;
			}
		}

		const areas = new Map<string, TileKey>();
		const candidates: { slot: Slot<T>; priority: number }[] = [];
		for (const layer of LAYERS) {
			for (const { key, id, distanceKm } of selection[layer]) {
				const slot = this.#slots[layer].get(id) as Slot<T>;
				if (slot.state === 'ready') {
					areas.set(id, key);
					continue;
				}
				if (slot.state === 'missing') continue;
				const descendants: TileKey[] = [];
				const covered = this.#covered(layer, key, COVER_DEPTH, descendants);
				for (const d of descendants) areas.set(keyOf(d), d);
				if (covered) continue;
				areas.set(id, key);
				const requestable = slot.state === 'idle' || (slot.state === 'failed' && now >= slot.retryAt);
				if (!hold && requestable && now - slot.wantedSince >= this.options.dwellMs && !candidates.some((c) => c.slot === slot)) {
					const shown = this.#best(layer, key);
					const texel = shown ? this.options.texelKm(shown.key.z) : this.options.baseTexelKm;
					candidates.push({ slot, priority: (texel * scale) / distanceKm - key.z * 1e-6 });
				}
			}
		}

		const patches: Patch<T>[] = [];
		let deepest = 0;
		for (const [id, key] of [...areas].sort((a, b) => a[1].z - b[1].z)) {
			const day = this.#best('day', key);
			const night = this.#best('night', key);
			if (!day && !night) continue;
			for (const slot of [day, night]) {
				if (!slot) continue;
				slot.usedFrame = frame;
				slot.lastUsed = now;
				slot.drawn = true;
				if (slot.key.z === key.z) deepest = Math.max(deepest, key.z);
			}
			patches.push({
				key,
				id,
				day: day && { key: day.key, resource: day.resource as T },
				night: night && { key: night.key, resource: night.resource as T },
			});
		}

		this.#expire(now);
		this.#fit(frame);
		candidates.sort((a, b) => b.priority - a.priority);
		let started = 0;
		for (const { slot } of candidates) {
			if (!this.#admit(frame, now)) break;
			this.#start(slot);
			started++;
		}
		this.#stats = this.#summary(wanted, patches.length, candidates.length - started, deepest);
		return patches;
	}

	/** Drops every texture and request; tiles known to be missing stay known. */
	clear(): void {
		for (const layer of LAYERS) {
			for (const slot of [...this.#slots[layer].values()]) if (slot.state !== 'missing') this.#drop(slot);
		}
		this.#arrived = [];
	}

	dispose(): void {
		this.#disposed = true;
		this.clear();
	}

	#slot(layer: Layer, key: TileKey, id: string): Slot<T> {
		let slot = this.#slots[layer].get(id);
		if (!slot) {
			slot = { layer, key, id, state: 'idle', token: 0, reserved: false, wantedSince: 0, lastWanted: -Infinity, usedFrame: 0, lastUsed: 0, drawn: false, failures: 0, retryAt: 0 };
			this.#slots[layer].set(id, slot);
		}
		return slot;
	}

	/** Finest loaded tile of a layer at or above `key`. */
	#best(layer: Layer, key: TileKey): Slot<T> | undefined {
		for (let z = Math.min(key.z, this.options.finest[layer]); z >= this.options.coarsest; z--) {
			const slot = this.#slots[layer].get(keyOf(ancestorOf(key, z)));
			if (slot?.state === 'ready') return slot;
		}
		return undefined;
	}

	/** Whether loaded descendants cover the whole tile; collects the loaded ones either way. */
	#covered(layer: Layer, key: TileKey, depth: number, found: TileKey[]): boolean {
		if (depth === 0 || key.z >= this.options.finest[layer]) return false;
		let all = true;
		for (const child of childrenOf(key)) {
			if (this.#slots[layer].get(keyOf(child))?.state === 'ready') found.push(child);
			else if (!this.#covered(layer, child, depth - 1, found)) all = false;
		}
		return all;
	}

	#install() {
		let installed = 0;
		while (this.#arrived.length && installed < this.options.installsPerFrame) {
			const { slot, token } = this.#arrived.shift() as { slot: Slot<T>; token: number };
			if (!this.#current(slot, token)) continue;
			slot.state = 'ready';
			slot.controller = undefined;
			this.#counts.loaded++;
			installed++;
		}
	}

	#current(slot: Slot<T>, token: number): boolean {
		return !this.#disposed && this.#slots[slot.layer].get(slot.id) === slot && slot.token === token && slot.state === 'loading';
	}

	/** Cancels requests left unwanted and forgets empty entries. */
	#expire(now: number) {
		for (const layer of LAYERS) {
			for (const slot of [...this.#slots[layer].values()]) {
				const idle = now - slot.lastWanted;
				if (slot.state === 'loading' && idle > this.options.abortMs) {
					this.#counts.aborted++;
					this.#cancel(slot);
				} else if ((slot.state === 'idle' || slot.state === 'failed') && idle > this.options.forgetMs) {
					this.#slots[layer].delete(slot.id);
				}
			}
		}
	}

	/** Evicts textures not drawn this frame, least recently used first, until within budget. */
	#fit(frame: number, room = 0): boolean {
		while (this.#bytes + room > this.options.maxBytes) {
			let victim: Slot<T> | undefined;
			for (const layer of LAYERS) {
				for (const slot of this.#slots[layer].values()) {
					if (slot.state === 'ready' && slot.usedFrame !== frame && (!victim || slot.lastUsed < victim.lastUsed)) victim = slot;
				}
			}
			if (!victim) return false;
			this.#counts.evicted++;
			if (!victim.drawn) this.#counts.unused++;
			this.#drop(victim);
		}
		return true;
	}

	#admit(frame: number, now: number): boolean {
		if (this.#active >= this.options.concurrency || now < this.#pausedUntil) return false;
		this.#tokens = Math.min(this.options.burst, this.#tokens + ((now - this.#refilled) * this.options.perSecond) / 1000);
		this.#refilled = now;
		if (this.#tokens < 1) return false;
		return this.#fit(frame, this.options.tileBytes);
	}

	#start(slot: Slot<T>) {
		const token = ++slot.token;
		const controller = new AbortController();
		slot.state = 'loading';
		slot.controller = controller;
		slot.reserved = true;
		this.#bytes += this.options.tileBytes;
		this.#tokens--;
		this.#active++;
		this.#counts.requested++;
		this.source.load(slot.layer, slot.key, controller.signal).then(
			(resource) => {
				if (!this.#current(slot, token)) return this.source.dispose(resource);
				slot.resource = resource;
				slot.failures = 0;
				this.#errors = 0;
				this.#arrived.push({ slot, token });
			},
			(error: unknown) => {
				if (!this.#current(slot, token)) return;
				this.#release(slot);
				slot.controller = undefined;
				this.#fail(slot, error instanceof TileLoadError ? error.failure : { kind: 'retry' });
			},
		).finally(() => {
			this.#active--;
		});
	}

	#fail(slot: Slot<T>, failure: LoadFailure) {
		const now = this.#now();
		if (failure.kind === 'missing') {
			slot.state = 'missing';
			return;
		}
		if (failure.kind === 'throttled') {
			slot.state = 'idle';
			this.#pausedUntil = Math.max(this.#pausedUntil, now + Math.min(failure.retryAfterMs ?? THROTTLE_MS, 60_000));
			return;
		}
		this.#counts.failed++;
		slot.failures++;
		slot.state = 'failed';
		slot.retryAt = now + Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** (slot.failures - 1));
		this.#errors++;
		this.#pausedUntil = Math.max(this.#pausedUntil, now + Math.min(MAX_PAUSE_MS, 500 * 2 ** (this.#errors - 1)));
	}

	#cancel(slot: Slot<T>) {
		slot.controller?.abort();
		slot.controller = undefined;
		slot.token++;
		if (slot.resource !== undefined) this.source.dispose(slot.resource);
		slot.resource = undefined;
		slot.state = 'idle';
		this.#release(slot);
	}

	#release(slot: Slot<T>) {
		if (!slot.reserved) return;
		slot.reserved = false;
		this.#bytes -= this.options.tileBytes;
	}

	#drop(slot: Slot<T>) {
		this.#cancel(slot);
		this.#slots[slot.layer].delete(slot.id);
	}

	#summary(wanted: number, drawn: number, queued: number, deepest: number): TileLoaderStats {
		let textures = 0;
		let missing = 0;
		for (const layer of LAYERS) {
			for (const slot of this.#slots[layer].values()) {
				if (slot.state === 'ready') textures++;
				else if (slot.state === 'missing') missing++;
			}
		}
		return { wanted, drawn, textures, bytes: this.#bytes, queued, loading: this.#active, missing, deepest, ...this.#counts };
	}
}
