import { describe, expect, it } from 'vitest';
import { capOpacity, styleBounds, VOLUME_KNEE, VOLUME_MAX_OPACITY } from './bounds';

const SIZE = 16;

function field(texel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
	const data = new Uint8Array(SIZE * SIZE * 4);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) data.set(texel(x, y), (y * SIZE + x) * 4);
	}
	return data;
}

describe('styleBounds', () => {
	it('finds nothing to report when the styling changes nothing', () => {
		const a = field((x) => [x * 16, 100, 0, 255]);
		expect(styleBounds(a, a, SIZE, 1)).toMatchObject({ blocks: 16, meanAbs: 0, maxAbs: 0, bias: 0, maxTopKm: 0, liftedShare: 0 });
	});

	it('averages cover over 4 km blocks, so detail that cancels out within a block costs nothing', () => {
		const observed = field(() => [128, 100, 0, 255]);
		const styled = field((x, y) => [(x + y) % 2 === 0 ? 168 : 88, 100, 0, 255]);
		const bounds = styleBounds(observed, styled, SIZE, 1);
		expect(bounds.meanAbs).toBeLessThan(1e-9);
		expect(bounds.maxAbs).toBeLessThan(1e-9);
	});

	it('reports a uniform brightening as a bias', () => {
		const observed = field(() => [100, 100, 0, 255]);
		const styled = field(() => [125, 100, 0, 255]);
		const bounds = styleBounds(observed, styled, SIZE, 1);
		expect(bounds.bias).toBeCloseTo(25 / 255, 6);
		expect(bounds.maxAbs).toBeCloseTo(25 / 255, 6);
	});

	it('measures tops only where the cloud is opaque and its observed top reliable', () => {
		const observed = field((x) => [x < 8 ? 250 : 60, 128, 0, 255]);
		const styled = field((x) => [x < 8 ? 250 : 60, x < 8 ? 133 : 200, 0, 255]);
		expect(styleBounds(observed, styled, SIZE, 1).maxTopKm).toBeCloseTo((5 / 255) * 20, 6);
	});

	it('skips clear blocks and blocks without heights', () => {
		const observed = field((x) => [0, 100, 0, x < 8 ? 255 : 0]);
		expect(styleBounds(observed, observed, SIZE, 1).blocks).toBe(0);
	});

	it('sizes blocks from the window texel', () => {
		const a = field(() => [200, 100, 0, 255]);
		expect(styleBounds(a, a, SIZE, 2).blocks).toBe(64);
		expect(styleBounds(a, a, SIZE, 1).blocks).toBe(16);
		expect(styleBounds(a, a, SIZE, 0.5).blocks).toBe(4);
	});
});

describe('capOpacity', () => {
	it('draws thin cover as observed and eases dense cover to the cap', () => {
		expect(capOpacity(0)).toBe(0);
		expect(capOpacity(0.3)).toBeCloseTo(0.3, 9);
		expect(capOpacity(VOLUME_KNEE)).toBeCloseTo(VOLUME_KNEE, 9);
		expect(capOpacity(1)).toBeCloseTo(VOLUME_MAX_OPACITY, 9);
		expect(capOpacity(0.75)).toBeCloseTo((VOLUME_KNEE + VOLUME_MAX_OPACITY) / 2, 9);
		expect(capOpacity(2)).toBeCloseTo(VOLUME_MAX_OPACITY, 9);
	});
});

describe('styleBounds, drawn and lifted', () => {
	it('reports the eased cap as a drawn bias, apart from the cover bounds', () => {
		const a = field(() => [255, 200, 0, 255]);
		const bounds = styleBounds(a, a, SIZE, 1);
		expect(bounds.maxAbs).toBe(0);
		expect(bounds.drawnBias).toBeCloseTo(VOLUME_MAX_OPACITY - 1, 6);
	});

	it('counts semi-transparent tops lifted by more than 1 km', () => {
		const observed = field((x) => [x < 8 ? 120 : 250, 80, 0, 255]);
		const styled = field((x) => [x < 8 ? 120 : 250, x < 4 ? 160 : 80, 0, 255]);
		const bounds = styleBounds(observed, styled, SIZE, 1);
		expect(bounds.liftedShare).toBeCloseTo(0.5, 6);
		expect(bounds.maxLiftKm).toBeCloseTo((80 / 255) * 20, 6);
		expect(bounds.maxTopKm).toBe(0);
	});
});
