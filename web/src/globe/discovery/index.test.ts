import { PerspectiveCamera } from 'three';
import { expect, it } from 'vitest';
import { projectMarker } from './index';

it('occludes the far hemisphere and the horizon in a close tilted view', () => {
	const camera = new PerspectiveCamera(60, 1, .01, 100);
	camera.position.set(3, 0, 0); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
	expect(projectMarker(0, 0, camera)).not.toBeNull();
	expect(projectMarker(0, 180, camera)).toBeNull();
	expect(projectMarker(0, 90, camera)).toBeNull();
	camera.position.set(1.2, .5, 0); camera.lookAt(1, 0, 0); camera.updateMatrixWorld();
	expect(projectMarker(0, 180, camera)).toBeNull();
});
