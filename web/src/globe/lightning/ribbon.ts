import { BufferAttribute, InstancedBufferGeometry } from 'three';

/** One quad per channel segment instance; per vertex: which end (0 or 1) and which side (-1 or 1). */
export function segmentGeometry(): InstancedBufferGeometry {
	const g = new InstancedBufferGeometry();
	g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
	g.setAttribute('corner', new BufferAttribute(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), 2));
	g.setIndex([0, 2, 1, 1, 2, 3]);
	return g;
}
