import {
	AdditiveBlending,
	BufferAttribute,
	Color,
	DynamicDrawUsage,
	InstancedBufferGeometry,
	InstancedInterleavedBuffer,
	InterleavedBufferAttribute,
	Mesh,
	ShaderMaterial,
	Vector2,
} from 'three';
import type { FlashRing } from '../live';
import { DEFAULT_LIGHTNING_CAPACITY, FLASH_STRIDE, FlashInstances } from './instances';
import { lightningFragmentShader, lightningVertexShader } from './lightning.glsl';

export { DEFAULT_LIGHTNING_CAPACITY, FlashInstances } from './instances';

/** Scene time a flash stays on screen; becomes adjustable in #55. */
export const DEFAULT_DISPLAY_MS = 1500;

const EARTH_RADIUS_KM = 6371;
export const CLOUD_TOP_KM = 12;

export interface LightningOptions {
	radius?: number;
	/** Most recent flashes kept on the GPU. */
	capacity?: number;
	displayMs?: number;
}

export interface Lightning {
	mesh: Mesh;
	/** Uploads new flashes and sets the scene time (UTC ms) flashes are aged against. */
	setTime(utcMs: number): void;
	dispose(): void;
}

/** A uniform shape of its own, so V8 keeps `value` a double in place instead of boxing it every frame. */
class NumberUniform {
	value = 0.5;
}

/** All flashes of the ring in one instanced draw call, aged on the GPU. */
export function createLightning(
	ring: FlashRing,
	{ radius = 1, capacity = DEFAULT_LIGHTNING_CAPACITY, displayMs = DEFAULT_DISPLAY_MS }: LightningOptions = {},
): Lightning {
	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute(
		'position',
		new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
	);
	geometry.setIndex([0, 1, 2, 0, 2, 3]);

	const instances = new FlashInstances(ring, capacity, (start, count) => {
		buffer.addUpdateRange(start * FLASH_STRIDE, count * FLASH_STRIDE);
		buffer.needsUpdate = true;
	});
	const buffer = new InstancedInterleavedBuffer(instances.data, FLASH_STRIDE).setUsage(DynamicDrawUsage);
	geometry.setAttribute('flash', new InterleavedBufferAttribute(buffer, 4, 0));
	geometry.setAttribute('flashShape', new InterleavedBufferAttribute(buffer, 2, 4));
	geometry.instanceCount = 0;

	const time = new NumberUniform();
	const material = new ShaderMaterial({
		vertexShader: lightningVertexShader,
		fragmentShader: lightningFragmentShader,
		uniforms: {
			time,
			duration: { value: displayMs / 1000 },
			radius: { value: radius },
			lift: { value: CLOUD_TOP_KM / EARTH_RADIUS_KM },
			kmToWorld: { value: radius / EARTH_RADIUS_KM },
			glowScale: { value: 4 },
			minPixels: { value: 5 },
			viewportHeight: { value: 1 },
			intensityFloor: { value: 0.15 },
			exposure: { value: 1.6 },
			color: { value: new Color('#e4ebff') },
		},
		blending: AdditiveBlending,
		transparent: true,
		depthWrite: false,
	});

	const mesh = new Mesh(geometry, material);
	mesh.frustumCulled = false;
	mesh.renderOrder = 1;
	const size = new Vector2();
	mesh.onBeforeRender = (renderer) => {
		material.uniforms.viewportHeight.value = renderer.getSize(size).y;
	};

	return {
		mesh,
		setTime(utcMs) {
			instances.sync(utcMs);
			geometry.instanceCount = instances.count;
			time.value = (utcMs - instances.origin) / 1000;
		},
		dispose() {
			geometry.dispose();
			material.dispose();
		},
	};
}
