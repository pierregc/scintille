import { type DataTexture, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
	columns,
	createCloudDetail,
	type DetailSource,
	detailSource,
	hasTile,
	levelFor,
	tileAt,
	viewPoints,
	wantedTiles,
} from './detail';

const MANIFEST = 'https://data.example/live/clouds/manifest.json';
const FINE_BYTES = (64 * 32) / 8;

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
		path: '../../archive/clouds/detail/2026/10/18/f/{z}/{y}/{x}.webp',
		tile_size: 640,
		border: 2,
		levels: [3, 4, 5],
		max_latitude: 72.7,
		fine: bitmap([[32, 9]]),
		size_bytes: 1,
		...overrides,
	};
}

function source(fine: [number, number][] = [[32, 9]]): DetailSource {
	const parsed = detailSource(ref({ fine: bitmap(fine) }), MANIFEST);
	if (!parsed) throw new Error('invalid test detail');
	return parsed;
}

describe('detailSource', () => {
	it('resolves the tile template against the manifest', () => {
		expect(source().template).toBe('https://data.example/archive/clouds/detail/2026/10/18/f/{z}/{y}/{x}.webp');
	});

	it('ignores detail the client cannot use', () => {
		expect(detailSource(undefined, MANIFEST)).toBeNull();
		expect(detailSource(ref({ tile_size: 512 }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ levels: [4, 5] }), MANIFEST)).toBeNull();
		expect(detailSource(ref({ path: 'detail/tile.webp' }), MANIFEST)).toBeNull();
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

	function setup(slots = 24) {
		const renderer = { copyTextureToTexture: vi.fn(), initTexture: vi.fn() };
		const fetchTile = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3])));
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
		expect(fetchTile.mock.calls.map(([url]) => String(url))).toContain(
			'https://data.example/archive/clouds/detail/2026/10/18/f/5/16/32.webp',
		);
		expect(renderer.copyTextureToTexture).toHaveBeenCalled();
		const pages = (detail.uniforms.detailPagesA.value as DataTexture).image.data as Uint8Array;
		const cell = (16 * 64 + 32) * 2 * 4;
		expect(pages[cell + 1]).toBe(5);
		expect(pages[cell + 2]).toBe(255);
		expect(pages[cell + 5]).toBe(4);
		expect(detail.uniforms.detailOn.value).toBe(1);
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
		const b = detailSource({ ...ref({ fine: bitmap([[32, 16]]) }), path: 'other/{z}/{y}/{x}.webp' }, MANIFEST);
		detail.update(view([b, b]));
		await detail.idle();
		const layers = renderer.copyTextureToTexture.mock.calls.map(([, , , position]) => (position as Vector3).z);
		expect(Math.max(...layers)).toBeLessThan(6);
		expect(layers.length).toBeGreaterThan(3);
		detail.dispose();
	});
});
