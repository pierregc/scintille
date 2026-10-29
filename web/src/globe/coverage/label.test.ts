import { PerspectiveCamera, Vector2 } from 'three';
import { describe, expect, it } from 'vitest';
import { surfacePoint } from './label';

describe('surfacePoint', () => {
	it('inverts latLonToVector at the center of the view', () => {
		const camera = new PerspectiveCamera(35, 1, 0.1, 100);
		camera.position.set(0, 0, -5);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld();
		const point = surfacePoint(new Vector2(0, 0), camera, 1);
		expect(point?.lat).toBeCloseTo(0);
		expect(point?.lon).toBeCloseTo(90);
	});

	it('is null off the globe', () => {
		const camera = new PerspectiveCamera(35, 1, 0.1, 100);
		camera.position.set(5, 0, 0);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld();
		expect(surfacePoint(new Vector2(0.99, 0.99), camera, 1)).toBeNull();
	});
});
