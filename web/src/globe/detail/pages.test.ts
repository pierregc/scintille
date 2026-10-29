import { describe, expect, it } from 'vitest';
import { type PagePatch, SurfacePages } from './pages';

// A small pyramid: level 1 is 2 × 1 tiles, the finest level 3 is 8 × 4 cells.
const pages = () => new SurfacePages(8, 4, 3, 400);

function cell(p: SurfacePages, layer: 0 | 1, x: number, yNorth: number) {
	const row = p.rows - 1 - yNorth;
	const o = ((row * p.columns + x) * 2 + layer) * 4;
	const [shown, from, levels, fade] = p.data.slice(o, o + 4);
	return { shown, from, z: levels & 15, fromZ: levels >> 4, fade };
}

describe('SurfacePages', () => {
	it('starts on the global textures everywhere', () => {
		const p = pages();
		expect(p.active).toBe(false);
		expect(cell(p, 0, 3, 1)).toEqual({ shown: 0, from: 0, z: 0, fromZ: 0, fade: 255 });
	});

	it('covers every finest cell of a patch, rows counted from the south', () => {
		const p = pages();
		expect(p.update([{ key: { z: 2, x: 1, y: 0 }, day: { layer: 7, z: 2 } }], 0)).toBe(true);
		for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) expect(cell(p, 0, x, y)).toMatchObject({ shown: 7, z: 2 });
		expect(cell(p, 0, 4, 0).z).toBe(0);
		expect(cell(p, 0, 2, 2).z).toBe(0);
		expect(cell(p, 1, 2, 0).z).toBe(0);
		expect(p.active).toBe(true);
	});

	it('lets finer patches cover coarser ones whatever their order', () => {
		const p = pages();
		p.update([
			{ key: { z: 3, x: 1, y: 1 }, night: { layer: 3, z: 3 } },
			{ key: { z: 1, x: 0, y: 0 }, night: { layer: 1, z: 1 } },
		], 0);
		expect(cell(p, 1, 1, 1)).toMatchObject({ shown: 3, z: 3 });
		expect(cell(p, 1, 0, 0)).toMatchObject({ shown: 1, z: 1 });
	});

	it('fades a new tile in over what the cell showed', () => {
		const p = pages();
		const coarse: PagePatch = { key: { z: 1, x: 0, y: 0 }, day: { layer: 1, z: 1 } };
		p.update([coarse], 0);
		expect(cell(p, 0, 0, 0)).toEqual({ shown: 1, from: 0, z: 1, fromZ: 0, fade: 0 });
		p.update([coarse], 200);
		expect(cell(p, 0, 0, 0).fade).toBe(128);
		p.update([coarse], 400);
		expect(cell(p, 0, 0, 0)).toEqual({ shown: 1, from: 1, z: 1, fromZ: 1, fade: 255 });
		expect(p.update([coarse], 500)).toBe(false);

		p.update([coarse, { key: { z: 3, x: 0, y: 0 }, day: { layer: 5, z: 3 } }], 1000);
		expect(cell(p, 0, 0, 0)).toEqual({ shown: 5, from: 1, z: 3, fromZ: 1, fade: 0 });
		expect(cell(p, 0, 1, 0).fade).toBe(255);
	});

	it('fades back to coarser tiles and to the global texture', () => {
		const p = pages();
		const fine: PagePatch = { key: { z: 3, x: 0, y: 0 }, day: { layer: 5, z: 3 } };
		p.update([fine], 0);
		p.update([fine], 400);
		p.update([], 1000);
		expect(cell(p, 0, 0, 0)).toEqual({ shown: 0, from: 5, z: 0, fromZ: 3, fade: 0 });
		expect(p.active).toBe(true);
		p.update([], 1400);
		expect(cell(p, 0, 0, 0).fade).toBe(255);
		expect(p.active).toBe(false);
	});

	it('keeps the start of a fade that has barely begun when the cell changes again', () => {
		const p = pages();
		p.update([{ key: { z: 3, x: 0, y: 0 }, day: { layer: 1, z: 2 } }], 0);
		p.update([{ key: { z: 3, x: 0, y: 0 }, day: { layer: 2, z: 3 } }], 100);
		expect(cell(p, 0, 0, 0)).toMatchObject({ shown: 2, from: 0, fromZ: 0, fade: 0 });
		p.update([{ key: { z: 3, x: 0, y: 0 }, day: { layer: 3, z: 3 } }], 400);
		expect(cell(p, 0, 0, 0)).toMatchObject({ shown: 3, from: 2, fromZ: 3, fade: 0 });
	});

	it('cuts every use of a released layer', () => {
		const p = pages();
		p.update([{ key: { z: 1, x: 0, y: 0 }, day: { layer: 4, z: 1 }, night: { layer: 6, z: 1 } }], 0);
		p.update([{ key: { z: 1, x: 0, y: 0 }, day: { layer: 4, z: 1 }, night: { layer: 6, z: 1 } }], 400);
		p.update([{ key: { z: 1, x: 0, y: 0 }, day: { layer: 9, z: 1 } }], 500);
		expect(cell(p, 1, 0, 0)).toMatchObject({ shown: 0, from: 6, fade: 0 });
		p.release(6);
		p.release(4);
		expect(cell(p, 1, 0, 0)).toMatchObject({ shown: 0, from: 0, fade: 255 });
		expect(cell(p, 0, 0, 0)).toMatchObject({ shown: 9, from: 9, fade: 255 });
		expect(p.update([{ key: { z: 1, x: 0, y: 0 }, day: { layer: 9, z: 1 } }], 600)).toBe(true);
		expect(cell(p, 0, 0, 0)).toMatchObject({ shown: 9, from: 9, fade: 255 });
	});

	it('shows the global texture at once where a released layer was shown', () => {
		const p = pages();
		const patch: PagePatch = { key: { z: 3, x: 7, y: 3 }, day: { layer: 4, z: 3 } };
		p.update([patch], 0);
		p.update([patch], 400);
		p.release(4);
		expect(cell(p, 0, 7, 3)).toMatchObject({ shown: 0, from: 0, fade: 255 });
		p.update([{ key: { z: 3, x: 7, y: 3 }, day: { layer: 4, z: 2 } }], 500);
		expect(cell(p, 0, 7, 3)).toMatchObject({ shown: 4, z: 2, from: 0, fromZ: 0, fade: 0 });
	});

	it('clears at once', () => {
		const p = pages();
		p.update([{ key: { z: 1, x: 1, y: 0 }, day: { layer: 2, z: 1 } }], 0);
		p.clear();
		expect(p.active).toBe(false);
		expect(cell(p, 0, 5, 2)).toEqual({ shown: 0, from: 0, z: 0, fromZ: 0, fade: 255 });
	});
});
