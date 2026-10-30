import {
	BufferGeometry,
	Color,
	type Camera,
	DataUtils,
	Float32BufferAttribute,
	HalfFloatType,
	type IUniform,
	LinearFilter,
	Matrix4,
	Mesh,
	NearestFilter,
	NormalBlending,
	type Object3D,
	OrthographicCamera,
	RepeatWrapping,
	RGBAFormat,
	Scene,
	ShaderMaterial,
	type Texture,
	UnsignedByteType,
	Vector2,
	Vector3,
	Vector4,
	WebGL3DRenderTarget,
	WebGLArrayRenderTarget,
	type WebGLRenderer,
	WebGLRenderTarget,
} from 'three';
import {
	compositeFragmentShader,
	compositeVertexShader,
	fieldFragmentShader,
	marchFragmentShader,
	noiseFragmentShader,
	passVertexShader,
	resolveFragmentShader,
	sunFragmentShader,
} from './volume.glsl';
import { lookedAt } from '../surface';

export { volumeFieldGlsl } from './volume.glsl';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const KM_PER_DEGREE = (EARTH_RADIUS_KM * Math.PI) / 180;

/** Texel sizes (km) of the nested windows baked around the point looked at. */
export const WINDOW_TEXEL_KM = [1, 2, 4, 8] as const;
const NOISE_SIZE = 64;
/** Camera heights (km) over which the volume replaces the flat layer. */
export const VOLUME_FADE_KM = [1800, 2800] as const;
const DRIFT_KM_PER_HOUR = 10;

export interface Window {
	/** Centre latitude and longitude, radians. */
	lat: number;
	lon: number;
	/** Half spans, radians. */
	halfLat: number;
	halfLon: number;
}

/**
 * Window `k` of `texels` square around a point (degrees), its centre snapped to its own texel grid
 * so a moving view does not resample the clouds.
 */
export function windowAround(latDeg: number, lonDeg: number, k: number, texels: number): Window {
	const stepLat = WINDOW_TEXEL_KM[k] / KM_PER_DEGREE;
	const coarse = WINDOW_TEXEL_KM[WINDOW_TEXEL_KM.length - 1] / KM_PER_DEGREE;
	const snappedLat = Math.round(latDeg / coarse) * coarse;
	const cos = Math.max(Math.round(Math.cos(Math.min(Math.abs(snappedLat), 72.7) * DEG) * 20) / 20, 0.3);
	const stepLon = stepLat / cos;
	const lat = Math.round(latDeg / stepLat) * stepLat;
	const lon = Math.round(lonDeg / stepLon) * stepLon;
	return { lat: lat * DEG, lon: lon * DEG, halfLat: ((texels * stepLat) / 2) * DEG, halfLon: ((texels * stepLon) / 2) * DEG };
}

/** Sub-pixel of the 2 by 2 block marched in frame `n`. */
export function marchPhase(n: number): [number, number] {
	const order: [number, number][] = [[0, 0], [1, 1], [1, 0], [0, 1]];
	return order[n % 4];
}

/** How much the volume replaces the flat layer at a camera height (km). */
export function volumeFade(heightKm: number): number {
	const [a, b] = VOLUME_FADE_KM;
	const t = Math.min(1, Math.max(0, (heightKm - a) / (b - a)));
	return 1 - t * t * (3 - 2 * t);
}

export interface CloudVolumeOptions {
	/** Uniforms and defines of the cloud layer's opacity (frames, blend, detail). */
	opacity: { uniforms: Record<string, IUniform>; defines: Record<string, string> };
	/** Uniforms of the cloud-top height tiles (prefix `height`). */
	heights?: Record<string, IUniform>;
	/** Texels per window side. */
	texels?: number;
	/** Reduced resolution as a share of the CSS size. */
	scale?: number;
	maxSamples?: number;
	/** Styled detail (ADR 0030); off gives the observed columns only. */
	detail?: boolean;
}

export interface VolumeView {
	camera: Camera;
	/** The Earth mesh, whose frame the clouds live in. */
	earth: Object3D;
	/** Scene time, UTC ms. */
	now: number;
	/** Sun direction in the Earth's frame. */
	sun: Vector3;
	/** CSS size of the view. */
	width: number;
	height: number;
	/** Flash glow map over a window of the globe, or null. */
	light: { map: Texture; window: Vector4 } | null;
}

export interface CloudVolume {
	/** Full-screen composite; add to the scene. */
	readonly mesh: Mesh;
	/** What other materials need to read the field: share these uniforms and include `volumeFieldGlsl`. */
	readonly uniforms: Record<string, IUniform>;
	/** 0 to 1: how much the volume shows instead of the flat layer. */
	readonly fade: number;
	detail: boolean;
	/** Bakes and marches for this frame; call before rendering the scene. */
	render(renderer: WebGLRenderer, view: VolumeView): void;
	/** Share of each reduced pixel the clouds cover, for development checks. */
	coverage(renderer: WebGLRenderer): { width: number; height: number; values: Float32Array };
	dispose(): void;
}

const fullScreen = () => {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
	return geometry;
};

export function createCloudVolume({
	opacity,
	heights = {},
	texels = 512,
	scale = 0.5,
	maxSamples = 64,
	detail = true,
}: CloudVolumeOptions): CloudVolume {
	const field = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: UnsignedByteType });
	const sun = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: UnsignedByteType });
	for (const target of [field, sun]) {
		target.texture.minFilter = LinearFilter;
		target.texture.magFilter = LinearFilter;
		target.texture.generateMipmaps = false;
	}
	const noise = new WebGL3DRenderTarget(NOISE_SIZE, NOISE_SIZE, NOISE_SIZE, { depthBuffer: false, type: UnsignedByteType });
	noise.texture.wrapS = noise.texture.wrapT = noise.texture.wrapR = RepeatWrapping;
	noise.texture.minFilter = LinearFilter;
	noise.texture.magFilter = LinearFilter;
	noise.texture.generateMipmaps = false;
	const targetOptions = { depthBuffer: false, type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter };
	const fresh = new WebGLRenderTarget(1, 1, targetOptions);
	const history = [0, 1].map(() => new WebGLRenderTarget(1, 1, { ...targetOptions, minFilter: LinearFilter, magFilter: LinearFilter }));

	const windows = WINDOW_TEXEL_KM.map(() => new Vector4(0, 0, 1e-6, 1e-6));
	const uniforms: Record<string, IUniform> = {
		volumeField: { value: field.texture },
		volumeSun: { value: sun.texture },
		volumeWindows: { value: windows },
		volumeOn: { value: 0 },
	};
	const bakeWindow = { value: new Vector4() };
	const sunDir = { value: new Vector3(1, 0, 0) };
	const lightGain = { value: 2.5 };

	const pass = (fragmentShader: string, passUniforms: Record<string, IUniform>, defines: Record<string, string> = {}) =>
		new ShaderMaterial({ vertexShader: passVertexShader, fragmentShader, uniforms: passUniforms, defines, depthTest: false, depthWrite: false });
	const noiseMaterial = pass(noiseFragmentShader, { slice: { value: 0 } });
	const fieldMaterial = pass(
		fieldFragmentShader,
		{ ...opacity.uniforms, ...heights, bakeWindow, bakeTexels: { value: texels } },
		{ ...opacity.defines, ...(Object.keys(heights).length > 0 ? { HEIGHTS: '' } : {}) },
	);
	const sunMaterial = pass(sunFragmentShader, { ...uniforms, bakeWindow, sunDir, lightGain });
	const rayMatrix = { value: new Matrix4() };
	const eyeKm = { value: new Vector3() };
	const marchSize = { value: new Vector2(1, 1) };
	const phase = { value: new Vector2() };
	const marchUniforms: Record<string, IUniform> = {
		...uniforms,
		rayMatrix,
		eyeKm,
		marchSize,
		phase,
		frameSeed: { value: 0 },
		pixelAngle: { value: 0.001 },
		noise: { value: noise.texture },
		detail: { value: detail ? 1 : 0 },
		driftKm: { value: 0 },
		sunDir,
		lightGain,
		maxSamples: { value: maxSamples },
		flashLight: { value: null },
		flashWindow: { value: new Vector4(0, 0, Math.PI, Math.PI / 2) },
		flashColor: { value: new Color('#dfe6ff') },
		flashGain: { value: 0 },
	};
	const marchMaterial = pass(marchFragmentShader, marchUniforms);
	const previous = { value: new Matrix4() };
	const historyValid = { value: 0 };
	const resolveUniforms: Record<string, IUniform> = {
		fresh: { value: fresh.texture },
		history: { value: history[0].texture },
		freshSize: { value: new Vector2(1, 1) },
		marchSize,
		phase,
		rayMatrix,
		eyeKm,
		previous,
		historyValid,
	};
	const resolveMaterial = pass(resolveFragmentShader, resolveUniforms);

	const passScene = new Scene();
	const passCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const quad = new Mesh(fullScreen(), noiseMaterial);
	quad.frustumCulled = false;
	passScene.add(quad);

	const fadeUniform = { value: 0 };
	const composite = new ShaderMaterial({
		vertexShader: compositeVertexShader,
		fragmentShader: compositeFragmentShader,
		uniforms: { resolved: { value: history[0].texture }, fade: fadeUniform },
		transparent: true,
		blending: NormalBlending,
		depthTest: false,
		depthWrite: false,
	});
	const mesh = new Mesh(fullScreen(), composite);
	mesh.frustumCulled = false;
	mesh.renderOrder = -1;
	mesh.visible = false;

	let noiseReady = false;
	let frame = 0;
	let current = 0;
	let baked = 0;
	let lastViewProjection: Matrix4 | null = null;
	const earthInverse = new Matrix4();
	const toEarth = new Matrix4();
	const viewProjection = new Matrix4();
	const eye = new Vector3();
	const look = new Vector3();
	const dir = new Vector3();

	const draw = (renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget | WebGLArrayRenderTarget | WebGL3DRenderTarget | null, layer = 0) => {
		quad.material = material;
		renderer.setRenderTarget(target, layer);
		renderer.render(passScene, passCamera);
	};

	const bake = (renderer: WebGLRenderer, k: number, latDeg: number, lonDeg: number) => {
		const w = windowAround(latDeg, lonDeg, k, texels);
		windows[k].set(w.lat, w.lon, w.halfLat, w.halfLon);
		bakeWindow.value.copy(windows[k]);
		draw(renderer, fieldMaterial, field, k);
		draw(renderer, sunMaterial, sun, k);
	};

	const volume: CloudVolume = {
		mesh,
		uniforms,
		get fade() { return fadeUniform.value; },
		get detail() { return marchUniforms.detail.value > 0.5; },
		set detail(on: boolean) { marchUniforms.detail.value = on ? 1 : 0; },
		render(renderer, view) {
			const camera = view.camera;
			earthInverse.copy(view.earth.matrixWorld).invert();
			eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(earthInverse);
			const radius = view.earth.matrixWorld.getMaxScaleOnAxis();
			const kmPerUnit = EARTH_RADIUS_KM / radius;
			const heightKm = (eye.length() - 1) * EARTH_RADIUS_KM;
			const fade = (opacity.uniforms.cloudShown?.value ?? 0) > 0.5 ? volumeFade(heightKm) : 0;
			fadeUniform.value = fade;
			uniforms.volumeOn.value = fade > 0 ? fade : 0;
			mesh.visible = fade > 0;
			if (fade <= 0) {
				lastViewProjection = null;
				baked = 0;
				return;
			}
			const target = renderer.getRenderTarget();
			const autoClear = renderer.autoClear;
			renderer.autoClear = false;
			if (!noiseReady) {
				for (let slice = 0; slice < NOISE_SIZE; slice++) {
					noiseMaterial.uniforms.slice.value = slice;
					draw(renderer, noiseMaterial, noise, slice);
				}
				noiseReady = true;
			}
			dir.set(0, 0, 0.5).unproject(camera as Camera & { projectionMatrixInverse: Matrix4 }).applyMatrix4(earthInverse).sub(eye).normalize();
			lookedAt(eye, dir, 1, look);
			const latDeg = Math.asin(look.y) / DEG;
			const lonDeg = Math.atan2(-look.z, look.x) / DEG;
			sunDir.value.copy(view.sun).normalize();
			// Every window at once after a jump, then one every other frame as the view and time move on.
			if (baked === 0) {
				for (let k = 0; k < WINDOW_TEXEL_KM.length; k++) bake(renderer, k, latDeg, lonDeg);
			} else if (baked % 2 === 0) bake(renderer, (baked / 2) % WINDOW_TEXEL_KM.length, latDeg, lonDeg);
			baked++;

			const width = Math.max(2, Math.round(view.width * scale));
			const height = Math.max(2, Math.round(view.height * scale));
			if (history[0].width !== width || history[0].height !== height) {
				for (const h of history) h.setSize(width, height);
				fresh.setSize(Math.ceil(width / 2), Math.ceil(height / 2));
				lastViewProjection = null;
			}
			marchSize.value.set(width, height);
			const fov = (camera as Camera & { fov?: number }).fov ?? 35;
			marchUniforms.pixelAngle.value = (2 * Math.tan((fov * DEG) / 2)) / height;
			resolveUniforms.freshSize.value.set(fresh.width, fresh.height);
			phase.value.set(...marchPhase(frame));
			marchUniforms.frameSeed.value = frame % 64;
			marchUniforms.driftKm.value = ((view.now / 3_600_000) * DRIFT_KM_PER_HOUR) % (22 * 1000);
			marchUniforms.flashLight.value = view.light?.map ?? null;
			if (view.light) marchUniforms.flashWindow.value = view.light.window;
			marchUniforms.flashGain.value = view.light ? 5 : 0;
			// Earth frame (km) to clip space, and its inverse for the rays.
			toEarth.copy(view.earth.matrixWorld).scale(new Vector3(1 / kmPerUnit, 1 / kmPerUnit, 1 / kmPerUnit));
			viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(toEarth);
			rayMatrix.value.copy(viewProjection).invert();
			eyeKm.value.copy(eye).multiplyScalar(EARTH_RADIUS_KM);

			draw(renderer, marchMaterial, fresh);
			historyValid.value = lastViewProjection ? 1 : 0;
			if (lastViewProjection) previous.value.copy(lastViewProjection);
			resolveUniforms.history.value = history[current].texture;
			current = 1 - current;
			draw(renderer, resolveMaterial, history[current]);
			composite.uniforms.resolved.value = history[current].texture;
			lastViewProjection = (lastViewProjection ?? new Matrix4()).copy(viewProjection);
			frame++;
			renderer.setRenderTarget(target);
			renderer.autoClear = autoClear;
		},
		coverage(renderer) {
			const target = history[current];
			const half = new Uint16Array(target.width * target.height * 4);
			renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, half);
			const values = new Float32Array(target.width * target.height);
			for (let i = 0; i < values.length; i++) values[i] = 1 - DataUtils.fromHalfFloat(half[i * 4 + 3]);
			return { width: target.width, height: target.height, values };
		},
		dispose() {
			for (const t of [field, sun, noise, fresh, ...history]) t.dispose();
			for (const m of [noiseMaterial, fieldMaterial, sunMaterial, marchMaterial, resolveMaterial, composite]) m.dispose();
			quad.geometry.dispose();
			mesh.geometry.dispose();
		},
	};
	return volume;
}
