import { BufferAttribute, InstancedBufferGeometry } from 'three';

/** Per vertex: branch, segment, end (0 or 1), side (-1 or 1). */
export function ribbonGeometry(branches: number, segments: number): InstancedBufferGeometry {
	const rib: number[] = [];
	const index: number[] = [];
	for (let b = 0; b <= branches; b++) {
		for (let s = 0; s < segments; s++) {
			const v = rib.length / 4;
			rib.push(b, s, 0, -1, b, s, 0, 1, b, s, 1, -1, b, s, 1, 1);
			index.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
		}
	}
	const g = new InstancedBufferGeometry();
	g.setAttribute('position', new BufferAttribute(new Float32Array(rib.length / 4 * 3), 3));
	g.setAttribute('rib', new BufferAttribute(new Float32Array(rib), 4));
	g.setIndex(index);
	return g;
}

