import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { BAKE, bakeServes, bakeSize, type BakeView, bakeViewProjection, type ScreenView } from './bake';

const SHELL = 1.003;

function camera(lat: number, lon: number, distance: number, aspect = 16 / 9): PerspectiveCamera {
	const c = new PerspectiveCamera(35, aspect, 0.01, 100);
	const r = Math.PI / 180;
	c.position.set(Math.cos(lat * r) * Math.cos(lon * r), Math.sin(lat * r), -Math.cos(lat * r) * Math.sin(lon * r)).multiplyScalar(distance);
	c.lookAt(0, 0, 0);
	c.updateMatrixWorld();
	return c;
}

const kmPerPx = (c: PerspectiveCamera) => ((c.position.length() - 1) * 6371 * 2 * Math.tan((35 * Math.PI) / 360)) / 1000;

function bakeOf(c: PerspectiveCamera): BakeView {
	return { viewProjection: bakeViewProjection(c.projectionMatrix, c.matrixWorldInverse), eye: c.position.clone(), kmPerPx: kmPerPx(c) };
}

function screenOf(c: PerspectiveCamera): ScreenView {
	return { inverseViewProjection: new Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).invert(), eye: c.position.clone(), kmPerPx: kmPerPx(c) };
}

describe('bake size', () => {
	it('covers the viewport and its margin at the requested share', () => {
		expect(bakeSize(1000, 600, 1, 8192)).toEqual({ width: 1150, height: 690, scale: 1 });
		expect(bakeSize(1000, 600, 0.5, 8192)).toEqual({ width: 575, height: 345, scale: 0.5 });
	});

	it('caps texels and texture size, and reports the share kept', () => {
		const big = bakeSize(2560, 1440, 1, 8192);
		expect(big.width * big.height).toBeLessThanOrEqual(BAKE.maxTexels * 1.001);
		expect(big.scale).toBeLessThan(1);
		expect(big.width / big.height).toBeCloseTo(2560 / 1440, 2);
		expect(bakeSize(4000, 100, 1, 2048).width).toBe(2048);
	});
});

describe('bake projection', () => {
	it('sees the screen inside its margin', () => {
		const c = camera(20, -30, 4);
		const view = bakeViewProjection(c.projectionMatrix, c.matrixWorldInverse);
		const corner = new Vector3(1, 1, 0.5).unproject(c);
		const clip = new Vector4(corner.x, corner.y, corner.z, 1).applyMatrix4(view);
		expect(clip.x / clip.w).toBeCloseTo(1 / (1 + BAKE.margin));
		expect(clip.y / clip.w).toBeCloseTo(1 / (1 + BAKE.margin));
	});
});

describe('bake reuse', () => {
	it('serves the view it was baked from and small moves', () => {
		const baked = bakeOf(camera(20, -30, 4));
		expect(bakeServes(baked, screenOf(camera(20, -30, 4)), SHELL)).toBe(true);
		expect(bakeServes(baked, screenOf(camera(20.5, -30.5, 4)), SHELL)).toBe(true);
		expect(bakeServes(baked, screenOf(camera(20, -30, 4.1)), SHELL)).toBe(true);
	});

	it('calls for a new bake when the globe turns, the scale drifts or the view leaves it', () => {
		const wide = bakeOf(camera(20, -30, 4));
		expect(bakeServes(wide, screenOf(camera(20, -10, 4)), SHELL)).toBe(false);
		expect(bakeServes(wide, screenOf(camera(20, -30, 3.4)), SHELL)).toBe(false);
		const close = bakeOf(camera(20, -30, 1.3));
		expect(bakeServes(close, screenOf(camera(20, -30, 1.3)), SHELL)).toBe(true);
		expect(bakeServes(close, screenOf(camera(20, -22, 1.3)), SHELL)).toBe(false);
	});

	it('ignores sky and the dim limb', () => {
		const far = bakeOf(camera(0, 0, 12));
		expect(bakeServes(far, screenOf(camera(0, 1, 12)), SHELL)).toBe(true);
	});
});
