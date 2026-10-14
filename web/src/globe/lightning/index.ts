import {
	AdditiveBlending,
	BufferAttribute,
	Color,
	CustomBlending,
	MaxEquation,
	OneFactor,
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
import { browserStorage, type PreferenceStorage } from '../clouds/preference';
import type { FlashRing, SourceDelays } from '../live';
import { assertDisplayMinutes, displayMs, readDisplayMinutes, writeDisplayMinutes } from './display';
import { CHANNEL } from './channel';
import { CHANNEL_CAPACITY, CHANNEL_STRIDE, ChannelInstances } from './channel-instances';
import { ribbonGeometry } from './ribbon';
import { ribbonFragment, ribbonVertex } from './ribbon.glsl';
import { FLASH_STRIDE, FlashInstances } from './instances';
import { lightMapFragmentShader, lightMapVertexShader } from './light-map.glsl';
import { lightningFragmentShader, lightningVertexShader } from './lightning.glsl';

export { DISPLAY_MINUTES } from './display';
export { FlashInstances } from './instances';

const EARTH_RADIUS_KM = 6371;
export const CLOUD_TOP_KM = 12;

export interface LightningOptions {
	radius?: number;
	/** Flashes kept on the GPU around the playhead; defaults to the ring's capacity. */
	capacity?: number;
	/** Where the display duration persists; null keeps it in memory only. */
	storage?: PreferenceStorage | null;
	/** Equirectangular flash light map width, for clouds lit from inside; 0 disables it. */
	lightMapWidth?: number;
}

export interface Lightning {
	mesh: Mesh;
	/** Uploads new flashes and sets the scene time (UTC ms) flashes are aged against, each source `delays` behind. */
	setTime(utcMs: number, delays?: SourceDelays): void;
	/** Minutes of scene time a flash stays on screen. */
	readonly displayMinutes: number;
	/** Changes how long flashes stay on screen, from the data already loaded, and remembers the choice. */
	setDisplayMinutes(minutes: number): void;
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
	{ radius = 1, capacity = ring.capacity, storage = browserStorage(), lightMapWidth = 1024 }: LightningOptions = {},
): Lightning {
	let displayMinutes = readDisplayMinutes(storage);
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
		displayMs(displayMinutes),
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
			duration: { value: displayMs(displayMinutes) / 1000 },
			radius: { value: radius },
			lift: { value: CLOUD_TOP_KM / EARTH_RADIUS_KM },
			kmToWorld: { value: radius / EARTH_RADIUS_KM },
			glowScale: { value: 4 },
			minPixels: { value: 5 },
			viewportHeight: { value: 1 },
			flicker: { value: 1 },
			haloStrength: { value: 1 },
			exposure: { value: 1.6 },
			color: { value: new Color('#e4ebff') },
		},
		blending: AdditiveBlending,
		transparent: true,
		depthWrite: false,
	});

	const channels = new ChannelInstances(ring, Math.min(capacity, CHANNEL_CAPACITY));
	const channelGeometry = ribbonGeometry(3, 16);
	const channelBuffer = new InstancedInterleavedBuffer(channels.data, CHANNEL_STRIDE).setUsage(DynamicDrawUsage);
	channelGeometry.setAttribute('flash', new InterleavedBufferAttribute(channelBuffer, 4, 0));
	channelGeometry.setAttribute('flashShape', new InterleavedBufferAttribute(channelBuffer, 3, 4));
	channelGeometry.setAttribute('channelSeed', new InterleavedBufferAttribute(channelBuffer, 1, 7));
	channelGeometry.instanceCount = 0;
	const channelMaterial = new ShaderMaterial({
		vertexShader: ribbonVertex(16),
		fragmentShader: ribbonFragment,
		uniforms: {
			...material.uniforms,
			viewport: { value: new Vector2(1, 1) },
			widthPx: { value: 1.6 },
			halo: { value: 0 },
		},
		transparent: true,
		depthWrite: false,
		blending: CustomBlending,
		blendEquation: MaxEquation,
		blendSrc: OneFactor,
		blendDst: OneFactor,
	});
	const channelMesh = new Mesh(channelGeometry, channelMaterial);
	channelMesh.frustumCulled = false;
	channelMesh.renderOrder = 2;
	channelMesh.onBeforeRender = (renderer) => {
		renderer.getSize(channelMaterial.uniforms.viewport.value).multiplyScalar(0.5);
	};

	const haloGeometry = ribbonGeometry(0, 8);
	for (const name of ['flash', 'flashShape', 'channelSeed']) {
		haloGeometry.setAttribute(name, channelGeometry.getAttribute(name));
	}
	haloGeometry.instanceCount = 0;
	const haloMaterial = new ShaderMaterial({
		vertexShader: ribbonVertex(8),
		fragmentShader: ribbonFragment,
		uniforms: { ...channelMaterial.uniforms, halo: { value: 1 } },
		transparent: true,
		depthWrite: false,
		blending: CustomBlending,
		blendEquation: MaxEquation,
		blendSrc: OneFactor,
		blendDst: OneFactor,
	});
	const haloMesh = new Mesh(haloGeometry, haloMaterial);
	haloMesh.frustumCulled = false;
	haloMesh.renderOrder = 2;
	channelMesh.renderOrder = 3;
	haloMesh.onBeforeRender = channelMesh.onBeforeRender;

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
	mesh.add(channelMesh, haloMesh);
	haloMesh.layers = mesh.layers;
	channelMesh.layers = mesh.layers;
	const size = new Vector2();
	mesh.onBeforeRender = (renderer) => {
		material.uniforms.viewportHeight.value = renderer.getSize(size).y;
	};

	return {
		mesh,
		setTime(utcMs, delays) {
			instances.sync(utcMs, delays);
			geometry.instanceCount = instances.count;
			time.value = (utcMs - instances.origin) / 1000;
			channels.sync(utcMs, instances.origin, displayMs(displayMinutes) / 1000, delays);
			channelGeometry.instanceCount = channels.count;
			const haloEnabled = channels.count <= CHANNEL.haloCapacity;
			haloGeometry.instanceCount = haloEnabled ? channels.count : 0;
			material.uniforms.haloStrength.value = haloEnabled ? 1 : 0;
			if (channels.count > 0) {
				channelBuffer.clearUpdateRanges();
				channelBuffer.addUpdateRange(0, channels.count * CHANNEL_STRIDE);
				channelBuffer.needsUpdate = true;
			}
		},
		get displayMinutes() {
			return displayMinutes;
		},
		setDisplayMinutes(minutes) {
			assertDisplayMinutes(minutes);
			displayMinutes = minutes;
			instances.lookbackMs = displayMs(minutes);
			material.uniforms.duration.value = displayMs(minutes) / 1000;
			writeDisplayMinutes(storage, minutes);
		},
		lightMap: lightMap?.target.texture ?? null,
		renderLightMap(renderer) {
			lightMap?.render(renderer);
		},
		dispose() {
			lightMap?.dispose();
			reducedMotion?.removeEventListener('change', applyMotion);
			haloGeometry.dispose();
			haloMaterial.dispose();
			channelGeometry.dispose();
			channelMaterial.dispose();
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
	const { time, duration, flicker } = flashes.uniforms;
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
