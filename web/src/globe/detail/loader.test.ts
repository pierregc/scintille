import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOADER, type Patch, TileLoader, TileLoadError, type TileLoaderOptions, type TileSource } from './loader';
import { keyOf, type Layer, type TileKey } from './pyramid';
import type { Selection } from './select';

interface Resource {
	id: string;
	disposed: boolean;
}

interface Call {
	id: string;
	signal: AbortSignal;
	settled: boolean;
	resolve(): void;
	reject(error: unknown): void;
}

class FakeSource implements TileSource<Resource> {
	calls: Call[] = [];
	live = new Set<Resource>();

	load(layer: Layer, key: TileKey, signal: AbortSignal): Promise<Resource> {
		const id = `${layer}:${keyOf(key)}`;
		return new Promise((resolve, reject) => {
			const call: Call = {
				id,
				signal,
				settled: false,
				resolve: () => {
					if (call.settled) return;
					call.settled = true;
					const resource = { id, disposed: false };
					this.live.add(resource);
					resolve(resource);
				},
				reject: (error) => {
					if (call.settled) return;
					call.settled = true;
					reject(error);
				},
			};
			signal.addEventListener('abort', () => call.reject(new DOMException('aborted', 'AbortError')));
			this.calls.push(call);
		});
	}

	dispose(resource: Resource) {
		resource.disposed = true;
		this.live.delete(resource);
	}

	pending(): Call[] {
		return this.calls.filter((c) => !c.settled);
	}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const k = (z: number, x: number, y: number): TileKey => ({ z, x, y });

function selection(day: TileKey[] = [], night: TileKey[] = [], distanceKm = 400): Selection {
	const wanted = (keys: TileKey[]) => keys.map((key) => ({ key, id: keyOf(key), distanceKm }));
	return { day: wanted(day), night: wanted(night) };
}

const ctx = { hold: false, scale: 3000 };

describe('TileLoader', () => {
	let time: number;
	let source: FakeSource;
	const make = (options: Partial<TileLoaderOptions> = {}) =>
		new TileLoader(source, {
			...DEFAULT_LOADER,
			coarsest: 2,
			finest: { day: 5, night: 4 },
			texelKm: (z) => 3.711 / 2 ** (z - 2),
			baseTexelKm: 9.78,
			tileBytes: 1,
			maxBytes: 100,
			now: () => time,
			...options,
		});
	/** Runs frames every 16 ms up to `until`. */
	const run = (loader: TileLoader<Resource>, sel: Selection, until: number, context = ctx): Patch<Resource>[] => {
		while (time < until) {
			loader.update(sel, context);
			time += 16;
		}
		return loader.update(sel, context);
	};
	const resolveAll = async () => {
		for (const call of source.pending()) call.resolve();
		await flush();
	};

	beforeEach(() => {
		time = 1000;
		source = new FakeSource();
	});

	it('requests a tile only once it has been wanted for the dwell time', () => {
		const loader = make();
		const sel = selection([k(5, 10, 20)]);
		run(loader, sel, 1280);
		expect(source.calls).toHaveLength(0);
		run(loader, sel, 1310);
		expect(source.calls.map((c) => c.id)).toEqual(['day:5/10-20']);
	});

	it('restarts the dwell after a tile leaves the selection', () => {
		const loader = make();
		run(loader, selection([k(5, 10, 20)]), 1200);
		run(loader, selection(), 1400);
		run(loader, selection([k(5, 10, 20)]), 1650);
		expect(source.calls).toHaveLength(0);
		run(loader, selection([k(5, 10, 20)]), 1720);
		expect(source.calls).toHaveLength(1);
	});

	it('starts nothing while held, then waits a full dwell', () => {
		const loader = make();
		const sel = selection([k(5, 10, 20)]);
		run(loader, sel, 3000, { ...ctx, hold: true });
		expect(source.calls).toHaveLength(0);
		run(loader, sel, 3250);
		expect(source.calls).toHaveLength(0);
		run(loader, sel, 3320);
		expect(source.calls).toHaveLength(1);
	});

	it('caps concurrent requests and fills freed places', async () => {
		const loader = make({ concurrency: 3 });
		const tiles = Array.from({ length: 8 }, (_, i) => k(5, i, 0));
		run(loader, selection(tiles), 1400);
		expect(source.pending()).toHaveLength(3);
		source.pending()[0].resolve();
		await flush();
		run(loader, selection(tiles), 1450);
		expect(source.calls).toHaveLength(4);
	});

	it('requests the most blurred areas first: shown by the base texture, then nearest', () => {
		const loader = make({ concurrency: 1 });
		const near = { key: k(5, 1, 0), id: '5/1-0', distanceKm: 400 };
		const far = { key: k(5, 2, 0), id: '5/2-0', distanceKm: 4000 };
		run(loader, { day: [far, near], night: [] }, 1400);
		expect(source.calls.map((c) => c.id)).toEqual(['day:5/1-0']);
	});

	it('ranks an area shown by a coarse ancestor before one already shown by a fine one', async () => {
		const loader = make({ concurrency: 1 });
		run(loader, selection([k(4, 0, 0)]), 1400);
		await resolveAll();
		run(loader, selection([k(4, 0, 0)]), 1450);
		const underFine = { key: k(5, 0, 0), id: '5/0-0', distanceKm: 400 };
		const underBase = { key: k(5, 40, 0), id: '5/40-0', distanceKm: 1200 };
		run(loader, { day: [underFine, underBase], night: [] }, 1900);
		expect(source.calls.map((c) => c.id)).toEqual(['day:4/0-0', 'day:5/40-0']);
	});

	it('requests a tile once, however often it is wanted', async () => {
		const loader = make();
		const sel = selection([k(5, 1, 1), k(5, 1, 1)], [k(4, 0, 0)]);
		run(loader, sel, 1400);
		run(loader, sel, 2000);
		expect(source.calls.map((c) => c.id).sort()).toEqual(['day:5/1-1', 'night:4/0-0']);
	});

	it('draws the nearest loaded ancestor while a tile loads, then the tile itself', async () => {
		const loader = make();
		run(loader, selection([k(3, 0, 0)]), 1400);
		await resolveAll();
		let patches = run(loader, selection([k(3, 0, 0)]), 1420);
		expect(patches.map((p) => [p.id, p.day?.key])).toEqual([['3/0-0', k(3, 0, 0)]]);

		patches = run(loader, selection([k(5, 1, 2)]), 1800);
		expect(patches.map((p) => [p.id, p.day?.key])).toEqual([['5/1-2', k(3, 0, 0)]]);
		await resolveAll();
		patches = run(loader, selection([k(5, 1, 2)]), 1820);
		expect(patches.map((p) => [p.id, p.day?.key])).toEqual([['5/1-2', k(5, 1, 2)]]);
	});

	it('draws night from its own level under finer day tiles', async () => {
		const loader = make();
		const sel = selection([k(5, 2, 2)], [k(4, 1, 1)]);
		run(loader, sel, 1400);
		await resolveAll();
		const patches = run(loader, sel, 1420);
		expect(patches.map((p) => [p.id, p.day?.key, p.night?.key])).toEqual([
			['4/1-1', undefined, k(4, 1, 1)],
			['5/2-2', k(5, 2, 2), k(4, 1, 1)],
		]);
	});

	it('shows at most a few new textures per frame', async () => {
		const loader = make({ installsPerFrame: 2 });
		const tiles = Array.from({ length: 5 }, (_, i) => k(5, i, 0));
		run(loader, selection(tiles), 1400);
		await resolveAll();
		expect(loader.update(selection(tiles), ctx)).toHaveLength(2);
		expect(loader.update(selection(tiles), ctx)).toHaveLength(4);
		expect(loader.update(selection(tiles), ctx)).toHaveLength(5);
	});

	it('cancels requests no longer wanted, and a late result never shows', async () => {
		const loader = make();
		run(loader, selection([k(5, 1, 1)]), 1400);
		const [call] = source.calls;
		call.resolve();
		run(loader, selection([k(5, 9, 9)]), 1800);
		await flush();
		expect(call.signal.aborted).toBe(true);
		expect(source.live.size).toBe(0);
		const patches = run(loader, selection([k(5, 1, 1)]), 1810);
		expect(patches).toEqual([]);
		expect(loader.stats.aborted).toBe(1);
	});

	it('keeps only the current request result when a tile is requested again', async () => {
		const loader = make();
		run(loader, selection([k(5, 1, 1)]), 1400);
		run(loader, selection(), 1800);
		run(loader, selection([k(5, 1, 1)]), 2200);
		expect(source.calls).toHaveLength(2);
		source.calls[1].resolve();
		await flush();
		const patches = run(loader, selection([k(5, 1, 1)]), 2220);
		expect(patches[0].day?.resource.disposed).toBe(false);
		expect(source.live.size).toBe(1);
	});

	it('disposes results that arrive after a clear', async () => {
		const loader = make();
		run(loader, selection([k(5, 1, 1)]), 1400);
		source.calls[0].resolve();
		loader.clear();
		await flush();
		expect(source.live.size).toBe(0);
		expect(run(loader, selection([k(5, 1, 1)]), 1410)).toEqual([]);
	});

	it('never reserves more than its byte budget and evicts the least recently drawn', async () => {
		const loader = make({ maxBytes: 3 });
		const first = [k(5, 0, 0), k(5, 1, 0), k(5, 2, 0)];
		run(loader, selection(first), 1400);
		await resolveAll();
		run(loader, selection(first), 1420);
		expect(loader.stats.textures).toBe(3);

		const second = [k(5, 50, 0), k(5, 51, 0)];
		run(loader, selection([first[2], ...second]), 1900);
		expect(loader.stats.bytes).toBeLessThanOrEqual(3);
		expect(source.pending()).toHaveLength(2);
		expect([...source.live].map((r) => r.id)).toEqual(['day:5/2-0']);
		await resolveAll();
		const patches = run(loader, selection([first[2], ...second]), 1920);
		expect(patches.map((p) => p.id).sort()).toEqual(['5/2-0', '5/50-0', '5/51-0']);
		expect(loader.stats.evicted).toBe(2);
	});

	it('leaves the rest at their fallback when the drawn tiles fill the budget', async () => {
		const loader = make({ maxBytes: 2 });
		const tiles = [k(5, 0, 0), k(5, 1, 0), k(5, 2, 0)];
		run(loader, selection(tiles), 1400);
		await resolveAll();
		run(loader, selection(tiles), 3000);
		expect(source.calls).toHaveLength(2);
		expect(loader.stats.textures).toBe(2);
		expect(loader.stats.queued).toBe(1);
	});

	it('shrinks to a lower budget', async () => {
		const loader = make({ maxBytes: 4 });
		const tiles = [k(5, 0, 0), k(5, 1, 0), k(5, 2, 0), k(5, 3, 0)];
		run(loader, selection(tiles), 1400);
		await resolveAll();
		run(loader, selection(tiles), 1420);
		loader.maxBytes = 1;
		run(loader, selection([tiles[0]]), 1440);
		expect(loader.stats.bytes).toBe(1);
		expect(source.live.size).toBe(1);
	});

	it('does not request a tile its loaded descendants already cover', async () => {
		const loader = make();
		const children = [k(5, 0, 0), k(5, 1, 0), k(5, 0, 1), k(5, 1, 1)];
		run(loader, selection(children), 1400);
		await resolveAll();
		run(loader, selection(children), 1420);
		const patches = run(loader, selection([k(4, 0, 0)]), 2000);
		expect(source.calls).toHaveLength(4);
		expect(patches.map((p) => p.id).sort()).toEqual(['5/0-0', '5/0-1', '5/1-0', '5/1-1']);
	});

	it('requests a tile its descendants cover only in part, and keeps drawing them over it', async () => {
		const loader = make();
		run(loader, selection([k(5, 0, 0)]), 1400);
		await resolveAll();
		const patches = run(loader, selection([k(4, 0, 0)]), 2000);
		expect(source.calls.map((c) => c.id)).toEqual(['day:5/0-0', 'day:4/0-0']);
		expect(patches.map((p) => p.id)).toEqual(['5/0-0']);
	});

	it('retries failed tiles with a backoff and pauses after errors', async () => {
		const loader = make();
		const sel = selection([k(5, 1, 1)]);
		run(loader, sel, 1400);
		source.calls[0].reject(new TileLoadError({ kind: 'retry' }));
		await flush();
		run(loader, sel, 3200);
		expect(source.calls).toHaveLength(1);
		expect(loader.stats.failed).toBe(1);
		run(loader, sel, 3500);
		expect(source.calls).toHaveLength(2);
		source.calls[1].reject(new TypeError('network'));
		await flush();
		run(loader, sel, 7400);
		expect(source.calls).toHaveLength(2);
		run(loader, sel, 7600);
		expect(source.calls).toHaveLength(3);
	});

	it('pauses every request after a network error', async () => {
		const loader = make();
		run(loader, selection([k(5, 1, 1)]), 1400);
		source.calls[0].reject(new TypeError('network'));
		await flush();
		run(loader, selection([k(5, 1, 1), k(5, 2, 2)]), 1700);
		expect(source.calls).toHaveLength(1);
		run(loader, selection([k(5, 1, 1), k(5, 2, 2)]), 2000);
		expect(source.calls.map((c) => c.id)).toEqual(['day:5/1-1', 'day:5/2-2']);
	});

	it('gives up on missing tiles and reports them', async () => {
		const loader = make();
		const sel = selection([k(5, 1, 1)]);
		run(loader, sel, 1400);
		source.calls[0].reject(new TileLoadError({ kind: 'missing' }));
		await flush();
		run(loader, sel, 90_000);
		expect(source.calls).toHaveLength(1);
		expect(loader.isMissing('day', k(5, 1, 1))).toBe(true);
		expect(loader.stats.missing).toBe(1);
	});

	it('waits for the server when throttled', async () => {
		const loader = make();
		run(loader, selection([k(5, 1, 1)]), 1400);
		source.calls[0].reject(new TileLoadError({ kind: 'throttled', retryAfterMs: 5000 }));
		await flush();
		run(loader, selection([k(5, 1, 1), k(5, 2, 2)]), 6000);
		expect(source.calls).toHaveLength(1);
		run(loader, selection([k(5, 1, 1), k(5, 2, 2)]), 6500);
		expect(source.calls).toHaveLength(3);
	});

	it('spreads requests under its rate cap', async () => {
		const loader = make({ burst: 3, perSecond: 2, concurrency: 20 });
		const tiles = Array.from({ length: 10 }, (_, i) => k(5, i, 0));
		run(loader, selection(tiles), 1400);
		expect(source.calls).toHaveLength(3);
		run(loader, selection(tiles), 2400);
		expect(source.calls).toHaveLength(5);
	});

	it('stays bounded over repeated navigation', async () => {
		const loader = make({ maxBytes: 6 });
		for (let round = 0; round < 40; round++) {
			const tiles = Array.from({ length: 4 }, (_, i) => k(5, (round * 4 + i) % 192, round % 96));
			run(loader, selection(tiles, [k(4, round % 96, 0)]), time + 400);
			await resolveAll();
			run(loader, selection(tiles), time + 50);
			expect(source.live.size).toBeLessThanOrEqual(6);
			expect(loader.stats.bytes).toBeLessThanOrEqual(6);
		}
		expect(loader.stats.loaded).toBeGreaterThan(100);
	});

	it('disposes everything, including later results', async () => {
		const loader = make();
		run(loader, selection([k(5, 1, 1), k(5, 2, 2)]), 1400);
		source.calls[0].resolve();
		await flush();
		run(loader, selection([k(5, 1, 1), k(5, 2, 2)]), 1420);
		loader.dispose();
		source.calls[1].resolve();
		await flush();
		expect(source.live.size).toBe(0);
		expect(loader.update(selection([k(5, 1, 1)]), ctx)).toEqual([]);
	});
});
