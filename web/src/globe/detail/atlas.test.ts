import type { Texture } from 'three';
import { describe, expect, it } from 'vitest';
import { type AtlasRenderer, LayerPool, mipSizes, TileAtlas } from './atlas';

function fakeRenderer() {
	const copies: { level: number; layer: number }[] = [];
	const initialized: Texture[] = [];
	const renderer = {
		initTexture: (texture: Texture) => initialized.push(texture),
		copyTextureToTexture: (_src: Texture, _dst: Texture, _region: unknown, at: { z: number } | null, srcLevel = 0, dstLevel = 0) => {
			expect(srcLevel).toBe(dstLevel);
			copies.push({ level: dstLevel, layer: at?.z ?? 0 });
		},
	} as unknown as AtlasRenderer;
	return { renderer, copies, initialized };
}

const bitmap = (size: number) => ({ width: size, height: size }) as ImageBitmap;

describe('mipSizes', () => {
	it('halves down to one texel', () => {
		expect(mipSizes(452)).toEqual([452, 226, 113, 56, 28, 14, 7, 3, 1]);
		expect(mipSizes(1)).toEqual([1]);
	});
});

describe('LayerPool', () => {
	it('hands out the lowest free layer and takes layers back once', () => {
		const pool = new LayerPool(3);
		expect([pool.take(), pool.take()]).toEqual([0, 1]);
		pool.give(0);
		pool.give(0);
		pool.give(7);
		expect(pool.used).toBe(1);
		expect([pool.take(), pool.take(), pool.take()]).toEqual([0, 2, null]);
	});
});

describe('TileAtlas', () => {
	it('allocates every mip level without uploading anything', () => {
		const { renderer, initialized } = fakeRenderer();
		const atlas = new TileAtlas(renderer, 4, 452, 8);
		expect(initialized).toEqual([atlas.texture]);
		expect(atlas.texture.mipmaps).toHaveLength(9);
		expect(atlas.texture.generateMipmaps).toBe(false);
		expect(atlas.texture.source.dataReady).toBe(false);
		expect(atlas.texture.image).toMatchObject({ width: 452, height: 452, depth: 4 });
	});

	it('copies every level of a tile into its layer, until the layers run out', () => {
		const { renderer, copies } = fakeRenderer();
		const atlas = new TileAtlas(renderer, 2, 452, 1);
		expect(atlas.upload(bitmap(452))).toBe(0);
		expect(copies).toEqual(mipSizes(452).map((_, level) => ({ level, layer: 0 })));
		expect(atlas.upload(bitmap(452))).toBe(1);
		expect(atlas.upload(bitmap(452))).toBeNull();
		atlas.free(0);
		expect(atlas.upload(bitmap(452))).toBe(0);
		expect(atlas.used).toBe(2);
	});

	it('refuses a tile of another size', () => {
		const { renderer, copies } = fakeRenderer();
		const atlas = new TileAtlas(renderer, 2, 452, 1);
		expect(atlas.upload(bitmap(450))).toBeNull();
		expect(copies).toEqual([]);
		expect(atlas.used).toBe(0);
	});
});
