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
	RGBAFormat,
	Scene,
	ShaderMaterial,
	type Texture,
	UnsignedByteType,
	Vector2,
	Vector3,
	Vector4,
	WebGLArrayRenderTarget,
	type WebGLRenderer,
	WebGLRenderTarget,
} from 'three';
import { type StyleBounds, styleBounds, VOLUME_KNEE, VOLUME_MAX_OPACITY } from './bounds';
import {
	compositeFragmentShader,
	compositeVertexShader,
	marchFragmentShader,
	passVertexShader,
	rawFieldFragmentShader,
	resolveFragmentShader,
	styleFragmentShader,
	sunFragmentShader,
} from './volume.glsl';

export { volumeFieldGlsl } from './field.glsl';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const KM_PER_DEGREE = (EARTH_RADIUS_KM * Math.PI) / 180;

/** Texel sizes (km) of the nested windows baked around the point looked at. */
export const WINDOW_TEXEL_KM = [1, 2, 4, 8] as const;
/** Camera heights (km) over which the volume replaces the flat layer. */
export const VOLUME_FADE_KM = [1800, 2800] as const;
/** Exaggeration of the styled tops' slopes in the lighting; the heights themselves are not exaggerated. */
const RELIEF = 1.6;
/** Brightness of sunlit cloud for the many scatterings a capped column leaves out, matched to the flat layer at noon. */
const SCATTER_GAIN = 2.3;

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

/** Element `index` (from 1) of the Halton sequence in a base: evenly spread offsets in 0 to 1. */
export function halton(index: number, base: number): number {
	let result = 0;
	let f = 1;
	for (let i = index; i > 0; i = Math.floor(i / base)) {
		f /= base;
		result += f * (i % base);
	}
	return result;
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
	/** What the atmosphere needs to haze the clouds by the air above them only (define CLOUD_HAZE). */
	readonly hazeUniforms: Record<string, IUniform>;
	/** 0 to 1: how much the volume shows instead of the flat layer. */
	readonly fade: number;
	detail: boolean;
	/** Bakes and marches for this frame; call before rendering the scene. */
	render(renderer: WebGLRenderer, view: VolumeView): void;
	/** March resolution (share of the CSS size) and most crossings per ray, when the quality tier changes. */
	setQuality(quality: { scale: number; maxSamples: number }): void;
	/** Share of each reduced pixel the clouds cover, for development checks. */
	coverage(renderer: WebGLRenderer): { width: number; height: number; values: Float32Array };
	/** How far the styling strays from the observations over the finest window, for development checks. */
	styleCheck(renderer: WebGLRenderer): StyleBounds;
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
	scale: initialScale = 0.5,
	maxSamples = 64,
	detail = true,
}: CloudVolumeOptions): CloudVolume {
	const field = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: UnsignedByteType });
	const sun = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: UnsignedByteType });
	const raw = new WebGLRenderTarget(texels, texels, { depthBuffer: false, type: UnsignedByteType });
	for (const target of [field, sun, raw]) {
		target.texture.minFilter = LinearFilter;
		target.texture.magFilter = LinearFilter;
		target.texture.generateMipmaps = false;
	}
	const targetOptions = { depthBuffer: false, type: HalfFloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter };
	// Light and transmittance, then the depth of the clouds seen, for the reprojection.
	const fresh = new WebGLRenderTarget(1, 1, { ...targetOptions, count: 2 });
	// The depth target also carries the flashes' glow, which the composite reads filtered.
	fresh.textures[1].minFilter = LinearFilter;
	fresh.textures[1].magFilter = LinearFilter;
	const history = [0, 1].map(() => new WebGLRenderTarget(1, 1, { ...targetOptions, minFilter: LinearFilter, magFilter: LinearFilter }));

	const windows = WINDOW_TEXEL_KM.map(() => new Vector4(0, 0, 1e-6, 1e-6));
	const uniforms: Record<string, IUniform> = {
		volumeField: { value: field.texture },
		volumeSun: { value: sun.texture },
		volumeWindows: { value: windows },
		volumeOn: { value: 0 },
		volumeMaxOpacity: { value: VOLUME_MAX_OPACITY },
		volumeKnee: { value: VOLUME_KNEE },
	};
	const bakeWindow = { value: new Vector4() };
	const bakeTexels = { value: texels };
	const sunDir = { value: new Vector3(1, 0, 0) };
	const lightGain = { value: 2.5 };

	const pass = (fragmentShader: string, passUniforms: Record<string, IUniform>, defines: Record<string, string> = {}) =>
		new ShaderMaterial({ vertexShader: passVertexShader, fragmentShader, uniforms: passUniforms, defines, depthTest: false, depthWrite: false });
	const rawMaterial = pass(
		rawFieldFragmentShader,
		{ ...opacity.uniforms, ...heights, bakeWindow, bakeTexels },
		{ ...opacity.defines, ...(Object.keys(heights).length > 0 ? { HEIGHTS: '' } : {}) },
	);
	const styleUniforms: Record<string, IUniform> = {
		rawField: { value: raw.texture },
		bakeWindow,
		bakeTexels,
		texelKm: { value: 1 },
		styled: { value: detail ? 1 : 0 },
		sunDir,
	};
	const styleMaterial = pass(styleFragmentShader, styleUniforms);
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
		pixelAngle: { value: 0.001 },
		subPixel: { value: new Vector2() },
		sunDir,
		lightGain,
		scatterGain: { value: SCATTER_GAIN },
		relief: { value: detail ? RELIEF : 1 },
		frameJitter: { value: 0 },
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
		fresh: { value: fresh.textures[0] },
		freshDepth: { value: fresh.textures[1] },
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
	const quad = new Mesh(fullScreen(), rawMaterial);
	quad.frustumCulled = false;
	passScene.add(quad);

	const fadeUniform = { value: 0 };
	const composite = new ShaderMaterial({
		vertexShader: compositeVertexShader,
		fragmentShader: compositeFragmentShader,
		uniforms: {
			resolved: { value: history[0].texture },
			freshDepth: { value: fresh.textures[1] },
			marchSize,
			freshSize: resolveUniforms.freshSize,
			phase,
			flashColor: marchUniforms.flashColor,
			fade: fadeUniform,
		},
		transparent: true,
		blending: NormalBlending,
		depthTest: false,
		depthWrite: false,
	});
	const viewport = { value: new Vector2(1, 1) };
	const hazeUniforms: Record<string, IUniform> = {
		cloudResolved: composite.uniforms.resolved,
		cloudDepth: { value: fresh.textures[1] },
		cloudMarchSize: marchSize,
		cloudFreshSize: resolveUniforms.freshSize,
		cloudPhase: phase,
		cloudFade: fadeUniform,
		cloudViewport: viewport,
	};
	const mesh = new Mesh(fullScreen(), composite);
	mesh.frustumCulled = false;
	mesh.renderOrder = -1;
	mesh.visible = false;

	let scale = initialScale;
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

	const draw = (renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget | WebGLArrayRenderTarget | null, layer = 0) => {
		quad.material = material;
		renderer.setRenderTarget(target, layer);
		renderer.render(passScene, passCamera);
	};

	// What a window's bake depends on: its place, the frames and their blend, the tiles loaded, the sun.
	const versionOf = (uniform: IUniform | undefined) => {
		const texture = uniform?.value as Texture | null | undefined;
		return texture ? `${texture.uuid}.${texture.version}` : '-';
	};
	const inputs = () => [
		versionOf(opacity.uniforms.cloudMap),
		versionOf(opacity.uniforms.cloudMapNext),
		Math.round((opacity.uniforms.cloudMix?.value ?? 0) * 64),
		versionOf(opacity.uniforms.detailPagesA),
		versionOf(opacity.uniforms.detailPagesB),
		versionOf(heights.heightPagesA),
		versionOf(heights.heightPagesB),
		sunDir.value.toArray().map((v) => Math.round(v * 1000)).join(','),
		styleUniforms.styled.value,
	].join('|');
	const signatures: string[] = WINDOW_TEXEL_KM.map(() => '');
	const signature = (k: number, latDeg: number, lonDeg: number, shared: string) => {
		const w = windowAround(latDeg, lonDeg, k, texels);
		return `${w.lat.toFixed(6)},${w.lon.toFixed(6)}|${shared}`;
	};

	// Observations, then their styling, then the sunlight through the styled columns.
	const bake = (renderer: WebGLRenderer, k: number, latDeg: number, lonDeg: number, shared: string) => {
		signatures[k] = signature(k, latDeg, lonDeg, shared);
		const w = windowAround(latDeg, lonDeg, k, texels);
		windows[k].set(w.lat, w.lon, w.halfLat, w.halfLon);
		bakeWindow.value.copy(windows[k]);
		styleUniforms.texelKm.value = WINDOW_TEXEL_KM[k];
		draw(renderer, rawMaterial, raw);
		draw(renderer, styleMaterial, field, k);
		draw(renderer, sunMaterial, sun, k);
	};

	const volume: CloudVolume = {
		mesh,
		uniforms,
		hazeUniforms,
		get fade() { return fadeUniform.value; },
		get detail() { return styleUniforms.styled.value > 0.5; },
		set detail(on: boolean) {
			styleUniforms.styled.value = on ? 1 : 0;
			marchUniforms.relief.value = on ? RELIEF : 1;
			baked = 0;
			lastViewProjection = null;
		},
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
			// The point looked at: the screen centre on the ground, else under the camera.
			dir.set(0, 0, 0.5).unproject(camera as Camera & { projectionMatrixInverse: Matrix4 }).applyMatrix4(earthInverse).sub(eye).normalize();
			const b = eye.dot(dir);
			const disc = b * b - (eye.lengthSq() - 1);
			look.copy(disc > 0 && -b - Math.sqrt(disc) > 0 ? dir.multiplyScalar(-b - Math.sqrt(disc)).add(eye) : eye).normalize();
			const latDeg = Math.asin(look.y) / DEG;
			const lonDeg = Math.atan2(-look.z, look.x) / DEG;
			sunDir.value.copy(view.sun).normalize();
			// Every window at once after a jump; then, every other frame, the next window whose inputs
			// changed, and one anyway every 32 frames in case something unseen moved.
			const shared = inputs();
			if (baked === 0) {
				for (let k = WINDOW_TEXEL_KM.length - 1; k >= 0; k--) bake(renderer, k, latDeg, lonDeg, shared);
			} else if (baked % 2 === 0) {
				const start = (baked / 2) % WINDOW_TEXEL_KM.length;
				let done = false;
				for (let i = 0; i < WINDOW_TEXEL_KM.length && !done; i++) {
					const k = (start + i) % WINDOW_TEXEL_KM.length;
					if (signatures[k] !== signature(k, latDeg, lonDeg, shared)) {
						bake(renderer, k, latDeg, lonDeg, shared);
						done = true;
					}
				}
				if (!done && baked % 32 === 0) bake(renderer, start, latDeg, lonDeg, shared);
			}
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
			// Golden-ratio steps: each pixel's offset visits the whole step evenly over a few frames.
			marchUniforms.frameJitter.value = ((Math.floor(frame / 4) * 0.618034) % 1 + 1) % 1;
			marchUniforms.subPixel.value.set(halton(Math.floor(frame / 4) + 1, 2) - 0.5, halton(Math.floor(frame / 4) + 1, 3) - 0.5);
			marchUniforms.flashLight.value = view.light?.map ?? null;
			if (view.light) marchUniforms.flashWindow.value = view.light.window;
			marchUniforms.flashGain.value = view.light ? 5 : 0;
			// Earth frame (km) to clip space, and its inverse for the rays.
			toEarth.copy(view.earth.matrixWorld).scale(new Vector3(1 / kmPerUnit, 1 / kmPerUnit, 1 / kmPerUnit));
			viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(toEarth);
			rayMatrix.value.copy(viewProjection).invert();
			eyeKm.value.copy(eye).multiplyScalar(EARTH_RADIUS_KM);

			renderer.getDrawingBufferSize(viewport.value);
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
		setQuality(quality) {
			scale = quality.scale;
			marchUniforms.maxSamples.value = quality.maxSamples;
		},
		coverage(renderer) {
			const target = history[current];
			const half = new Uint16Array(target.width * target.height * 4);
			renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, half);
			const values = new Float32Array(target.width * target.height);
			for (let i = 0; i < values.length; i++) values[i] = 1 - DataUtils.fromHalfFloat(half[i * 4 + 3]);
			return { width: target.width, height: target.height, values };
		},
		styleCheck(renderer) {
			const target = renderer.getRenderTarget();
			bakeWindow.value.copy(windows[0]);
			styleUniforms.texelKm.value = WINDOW_TEXEL_KM[0];
			const styled = new WebGLRenderTarget(texels, texels, { depthBuffer: false, type: UnsignedByteType });
			draw(renderer, rawMaterial, raw);
			draw(renderer, styleMaterial, styled);
			const read = (from: WebGLRenderTarget) => {
				const data = new Uint8Array(texels * texels * 4);
				renderer.readRenderTargetPixels(from, 0, 0, texels, texels, data);
				return data;
			};
			const bounds = styleBounds(read(raw), read(styled), texels, WINDOW_TEXEL_KM[0]);
			styled.dispose();
			renderer.setRenderTarget(target);
			return bounds;
		},
		dispose() {
			for (const t of [field, sun, raw, fresh, ...history]) t.dispose();
			for (const m of [rawMaterial, styleMaterial, sunMaterial, marchMaterial, resolveMaterial, composite]) m.dispose();
			quad.geometry.dispose();
			mesh.geometry.dispose();
		},
	};
	return volume;
}
