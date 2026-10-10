import {
	AdditiveBlending,
	BufferAttribute,
	Color,
	DynamicDrawUsage,
	HalfFloatType,
	InstancedBufferGeometry,
	InstancedInterleavedBuffer,
	InterleavedBufferAttribute,
	Mesh,
	OrthographicCamera,
	Points,
	Scene,
	ShaderMaterial,
	type Texture,
	Vector2,
	WebGLRenderTarget,
	type WebGLRenderer,
} from 'three';
import type { FlashRing } from '../live';
import { FLASH_STRIDE, FlashInstances } from './instances';
import { lightMapFragmentShader, lightMapVertexShader } from './light-map.glsl';
import { lightningFragmentShader, lightningVertexShader } from './lightning.glsl';

export { FlashInstances } from './instances';

/** Scene time a flash stays on screen; becomes adjustable in #55. */
export const DEFAULT_DISPLAY_MS = 1500;

const EARTH_RADIUS_KM = 6371;
export const CLOUD_TOP_KM = 12;

export interface LightningOptions {
	radius?: number;
	/** Flashes kept on the GPU around the playhead; defaults to the ring's capacity. */
	capacity?: number;
	displayMs?: number;
	/** Equirectangular flash light map width, for clouds lit from inside; 0 disables it. */
	lightMapWidth?: number;
}

export interface Lightning {
	mesh: Mesh;
	/** Uploads new flashes and sets the scene time (UTC ms) flashes are aged against. */
	setTime(utcMs: number): void;
	/** Glow of recent flashes in Earth UV space, or null when disabled. */
	lightMap: Texture | null;
	/** Redraws the light map; call once per frame before the main render. */
	renderLightMap(renderer: WebGLRenderer): void;
	dispose(): void;
}

/** A uniform shape of its own, so V8 keeps `value` a double in place instead of boxing it every frame. */
class NumberUniform {
	value = 0.5;
}

/** All flashes of the ring in one instanced draw call, aged on the GPU. */
export function createLightning(
	ring: FlashRing,
	{ radius = 1, capacity = ring.capacity, displayMs = DEFAULT_DISPLAY_MS, lightMapWidth = 1024 }: LightningOptions = {},
): Lightning {
	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute(
		'position',
		new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
	);
	geometry.setIndex([0, 1, 2, 0, 2, 3]);

	const instances = new FlashInstances(
		ring,
		capacity,
		(start, count) => {
			buffer.addUpdateRange(start * FLASH_STRIDE, count * FLASH_STRIDE);
			buffer.needsUpdate = true;
		},
		displayMs,
	);
	const buffer = new InstancedInterleavedBuffer(instances.data, FLASH_STRIDE).setUsage(DynamicDrawUsage);
	geometry.setAttribute('flash', new InterleavedBufferAttribute(buffer, 4, 0));
	geometry.setAttribute('flashShape', new InterleavedBufferAttribute(buffer, 3, 4));
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
			flicker: { value: 1 },
			exposure: { value: 1.6 },
			color: { value: new Color('#e4ebff') },
		},
		blending: AdditiveBlending,
		transparent: true,
		depthWrite: false,
	});

	const lightMap = lightMapWidth > 0 ? createLightMap(geometry, material, lightMapWidth) : null;

	const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
	const applyMotion = () => {
		material.uniforms.flicker.value = reducedMotion?.matches ? 0 : 1;
	};
	applyMotion();
	reducedMotion?.addEventListener('change', applyMotion);

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
		lightMap: lightMap?.target.texture ?? null,
		renderLightMap(renderer) {
			lightMap?.render(renderer);
		},
		dispose() {
			lightMap?.dispose();
			reducedMotion?.removeEventListener('change', applyMotion);
			geometry.dispose();
			material.dispose();
		},
	};
}

/** Renders the flashes into a low-resolution equirectangular glow map, wrapped at the dateline. */
function createLightMap(flashGeometry: InstancedBufferGeometry, flashes: ShaderMaterial, width: number) {
	const target = new WebGLRenderTarget(width, width / 2, { type: HalfFloatType, depthBuffer: false });
	const geometry = new InstancedBufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
	geometry.setAttribute('flash', flashGeometry.getAttribute('flash'));
	geometry.setAttribute('flashShape', flashGeometry.getAttribute('flashShape'));
	const { time, duration, flicker, intensityFloor } = flashes.uniforms;
	const scene = new Scene();
	const camera = new OrthographicCamera();
	const materials = [0, 1].map(
		(wrap) =>
			new ShaderMaterial({
				vertexShader: lightMapVertexShader,
				fragmentShader: lightMapFragmentShader,
				uniforms: {
					time,
					duration,
					flicker,
					intensityFloor,
					spreadKm: { value: 150 },
					wrap: { value: wrap },
					mapSize: { value: new Vector2(width, width / 2) },
				},
				blending: AdditiveBlending,
				depthTest: false,
				depthWrite: false,
			}),
	);
	for (const material of materials) {
		const points = new Points(geometry, material);
		points.frustumCulled = false;
		scene.add(points);
	}
	const clearColor = new Color();
	return {
		target,
		render(renderer: WebGLRenderer) {
			const previous = renderer.getRenderTarget();
			renderer.getClearColor(clearColor);
			const clearAlpha = renderer.getClearAlpha();
			renderer.setRenderTarget(target);
			renderer.setClearColor(0x000000, 0);
			renderer.clear(true, false, false);
			geometry.instanceCount = flashGeometry.instanceCount;
			if (geometry.instanceCount > 0) renderer.render(scene, camera);
			renderer.setClearColor(clearColor, clearAlpha);
			renderer.setRenderTarget(previous);
		},
		dispose() {
			target.dispose();
			geometry.dispose();
			materials.forEach((m) => m.dispose());
		},
	};
}
