import { type DataTexture, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
	columns,
	createCloudDetail,
	type DetailSource,
	detailSource,
	hasTile,
	indexSlot,
	levelFor,
	tileAt,
	viewPoints,
	wantedTiles,
} from './detail';

const MANIFEST = 'https://data.example/live/clouds/manifest.json';
const FINE_BYTES = (64 * 32) / 8;
const SLOTS = 128 + 512 + 2048;

/** A pack holding three bytes for every listed tile. */
function pack(keys: { z: number; x: number; y: number }[]): Uint8Array<ArrayBuffer> {
	const index = new Uint32Array(SLOTS * 2);
	const body: number[] = [];
	for (const key of keys) {
		const slot = indexSlot([3, 4, 5], key);
		index[2 * slot] = SLOTS * 8 + body.length;
		index[2 * slot + 1] = 3;
		body.push(key.z, key.y, key.x);
	}
	const out = new Uint8Array(SLOTS * 8 + body.length);
	out.set(new Uint8Array(index.buffer));
	out.set(body, SLOTS * 8);
	return out;
}

/** Serves byte ranges of `data`, as the data domain does. */
function rangeFetch(data: Uint8Array<ArrayBuffer>) {
	return vi.fn<typeof fetch>(async (_url, init) => {
		const range = new Headers(init?.headers).get('Range') ?? '';
		const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
		if (start === undefined) return new Response(data);
		return new Response(data.slice(Number(start), Number(end) + 1), { status: 206 });
	});
}

function bitmap(tiles: [number, number][] = []): string {
	const bits = new Uint8Array(FINE_BYTES);
	for (const [x, y] of tiles) {
		const i = y * columns(5) + x;
		bits[i >> 3] |= 1 << (i & 7);
	}
	return btoa(String.fromCharCode(...bits));
}

function ref(overrides: Record<string, unknown> = {}) {
	return {
		path: '../../archive/clouds/detail/2026/10/18/f.tiles',
		tile_size: 640,
		border: 2,
		levels: [3, 4, 5],
		max_latitude: 72.7,
		fine: bitmap([[32, 9]]),
		size_bytes: 1,
		index_bytes: SLOTS * 8,
		...overrides,
	};
}

function source(fine: [number, number][] = [[32, 9]]): DetailSource {
	const parsed = detailSource(ref({ fine: bitmap(fine) }), MANIFEST);
	if (!parsed) throw new Error('invalid test detail');
	return parsed;
}

describe('detailSource', () => {
	it('resolves the tile pack against the manifest', () => {
		expect(source().url).toBe('https://data.example/archive/clouds/detail/2026/10/18/f.tiles');
	});

	it('ignores detail the client cannot use', () => {
		expect(detailSource(undefined, MANIFEST)).toBeNull();
		expect(detailSource(ref({ tile_size: 512 }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ levels: [4, 5] }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ path: 'detail/tile.webp' }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ index_bytes: 8 }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ fine: btoa('short') }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ fine: '%%%' }), MANIFEST)).toBeNull();
	});
});

describe('hasTile', () => {
	it('lists coarse levels within the data latitudes and the finest from its bitmap', () => {
		const s = source();
		expect(hasTile(s, { z: 3, x: 0, y: 0 })).toBe(true);
		expect(hasTile(s, { z: 4, x: 0, y: 0 })).toBe(false);
		expect(hasTile(s, { z: 4, x: 31, y: 1 })).toBe(true);
		expect(hasTile(s, { z: 5, x: 32, y: 9 })).toBe(true);
		expect(hasTile(s, { z: 5, x: 33, y: 9 })).toBe(false);
		expect(hasTile(s, { z: 3, x: 16, y: 0 })).toBe(false);
	});

	it('lists only the coarse tiles a partial pack keeps', () => {
		const bits = new Uint8Array((128 + 512) / 8);
		const slot = 128 + 7 * columns(4) + 17;
		bits[slot >> 3] |= 1 << (slot & 7);
		const s = detailSource(ref({ coarse: btoa(String.fromCharCode(...bits)) }), MANIFEST);
		if (!s) throw new Error('invalid test detail');
		expect(hasTile(s, { z: 4, x: 17, y: 7 })).toBe(true);
		expect(hasTile(s, { z: 4, x: 18, y: 7 })).toBe(false);
		expect(hasTile(s, { z: 3, x: 8, y: 3 })).toBe(false);
		expect(hasTile(s, { z: 5, x: 32, y: 9 })).toBe(true);
		expect(detailSource(ref({ coarse: btoa('short') }), MANIFEST)).toBeNull();
		expect(source().coarse).toBeNull();
	});
});

describe('levelFor', () => {
	it('keeps the global frame from afar and reaches the finest level near the floor', () => {
		const s = source();
		expect(levelFor(s, 11.7)).toBeNull();
		expect(levelFor(s, 3.5)).toBe(3);
		expect(levelFor(s, 1.2)).toBe(4);
		expect(levelFor(s, 0.51)).toBe(5);
		expect(levelFor(s, 0.23)).toBe(5);
	});
});

describe('tileAt', () => {
	it('wraps longitudes and clamps the poles', () => {
		expect(tileAt(38.57, 2.62, 5)).toEqual({ z: 5, x: 32, y: 9 });
		expect(tileAt(0, 180, 3)).toEqual({ z: 3, x: 0, y: 4 });
		expect(tileAt(-90, -180, 3)).toEqual({ z: 3, x: 0, y: 7 });
	});
});

describe('wantedTiles', () => {
	it('loads coarse levels first, then the centre before the edges', () => {
		const s = source([[32, 9], [33, 9]]);
		const keys = wantedTiles(s, [
			{ lat: 38.5, lon: 8, kmPerPx: 0.23, offCentre: 0.9 },
			{ lat: 38.5, lon: 2.6, kmPerPx: 0.23, offCentre: 0 },
		]);
		expect(keys).toEqual([
			{ z: 3, x: 8, y: 2 },
			{ z: 4, x: 16, y: 4 },
			{ z: 5, x: 32, y: 9 },
			{ z: 5, x: 33, y: 9 },
		]);
	});

	it('skips tiles that were not published', () => {
		expect(wantedTiles(source([]), [{ lat: 38.5, lon: 2.6, kmPerPx: 0.23, offCentre: 0 }]).map((k) => k.z))
			.toEqual([3, 4]);
	});
});

describe('viewPoints', () => {
	it('measures about 0.23 km per CSS pixel at the 400 km floor', () => {
		const camera = new PerspectiveCamera(35, 16 / 9, 0.001, 10);
		camera.position.set(1 + 400 / 6371, 0, 0);
		camera.lookAt(new Vector3(0, 0, 0));
		camera.updateMatrixWorld();
		const points = viewPoints(camera, new Matrix4(), 1 + 10 / 6371, 1080);
		const centre = points.reduce((a, b) => (a.offCentre < b.offCentre ? a : b));
		expect(centre.kmPerPx).toBeCloseTo(0.228, 2);
		expect(centre.lat).toBeCloseTo(0, 5);
		expect(centre.lon).toBeCloseTo(0, 5);
	});
});

describe('createCloudDetail', () => {
	const camera = new PerspectiveCamera(35, 16 / 9, 0.001, 10);
	camera.position.set(1 + 400 / 6371, 0, 0);
	camera.lookAt(new Vector3(0, 0, 0));
	camera.updateMatrixWorld();

	const tilesUnderView = [5, 4, 3].flatMap((z) => [
		{ z, x: 32 >> (5 - z), y: 16 >> (5 - z) },
		{ z, x: 31 >> (5 - z), y: 16 >> (5 - z) },
		{ z, x: 32 >> (5 - z), y: 15 >> (5 - z) },
		{ z, x: 31 >> (5 - z), y: 15 >> (5 - z) },
	]);

	function setup(slots = 24, served = pack(tilesUnderView)) {
		const renderer = { copyTextureToTexture: vi.fn(), initTexture: vi.fn() };
		const fetchTile = rangeFetch(served);
		const decode = vi.fn(async (_: Blob, size: number) => new Uint8Array(size * size));
		const detail = createCloudDetail(renderer, { slots, fetch: fetchTile, decode, fadeMs: 0 });
		return { renderer, fetchTile, detail };
	}

	const view = (frames: [DetailSource | null, DetailSource | null]) => ({
		camera,
		inverseWorld: new Matrix4(),
		shellRadius: 1 + 10 / 6371,
		kmPerUnit: 6371,
		heightPx: 1080,
		frames,
		now: 0,
	});

	it('loads the tiles under the view into slots and points the pages at them', async () => {
		const { renderer, fetchTile, detail } = setup();
		const s = source([[32, 16], [31, 16], [32, 15], [31, 15]]);
		for (let i = 0; i < 3; i++) {
			detail.update(view([s, s]));
			await detail.idle();
		}
		detail.update(view([s, s]));
		const ranges = fetchTile.mock.calls.map(([, init]) => new Headers(init?.headers).get('Range'));
		expect(ranges[0]).toBe(`bytes=0-${SLOTS * 8 - 1}`);
		expect(ranges.filter((r) => r === `bytes=0-${SLOTS * 8 - 1}`)).toHaveLength(1);
		expect(ranges.length).toBeGreaterThan(8);
		expect(renderer.copyTextureToTexture).toHaveBeenCalled();
		const pages = (detail.uniforms.detailPagesA.value as DataTexture).image.data as Uint8Array;
		const cell = (16 * 64 + 32) * 2 * 4;
		expect(pages[cell + 1]).toBe(5);
		expect(pages[cell + 2]).toBe(255);
		expect(pages[cell + 5]).toBe(4);
		expect(detail.uniforms.detailOn.value).toBe(1);
		detail.dispose();
	});

	it('refuses a server that ignores byte ranges', async () => {
		const { renderer, detail } = setup();
		const s = source([[32, 16]]);
		const whole = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(10)));
		const other = createCloudDetail(renderer, { fetch: whole, decode: async (_: Blob, n: number) => new Uint8Array(n * n) });
		other.update(view([s, s]));
		await other.idle();
		expect(renderer.copyTextureToTexture).not.toHaveBeenCalled();
		other.dispose();
		detail.dispose();
	});

	it('shows nothing for frames without detail', () => {
		const { fetchTile, detail } = setup();
		detail.update(view([null, null]));
		expect(fetchTile).not.toHaveBeenCalled();
		expect(detail.uniforms.detailOn.value).toBe(0);
		detail.dispose();
	});

	it('reuses the least recently used slot once the array is full', async () => {
		const { renderer, detail } = setup(6);
		const a = source([[32, 16]]);
		detail.update(view([a, a]));
		await detail.idle();
		const b = detailSource({ ...ref({ fine: bitmap([[32, 16]]) }), path: 'other.tiles' }, MANIFEST);
		detail.update(view([b, b]));
		await detail.idle();
		const layers = renderer.copyTextureToTexture.mock.calls.map(([, , , position]) => (position as Vector3).z);
		expect(Math.max(...layers)).toBeLessThan(6);
		expect(layers.length).toBeGreaterThan(3);
		detail.dispose();
	});
});
