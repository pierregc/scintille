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
import { type StyleBounds, styleBounds, VEIL_MAX_OPACITY, VOLUME_KNEE, VOLUME_MAX_OPACITY } from './bounds';
import {
	compositeFragmentShader,
	compositeVertexShader,
	marchFragmentShader,
	reliefFragmentShader,
	passVertexShader,
	rawFieldFragmentShader,
	resolveFragmentShader,
	spreadFragmentShader,
	styleFragmentShader,
	sunFragmentShader,
} from './volume.glsl';
import { CLOUD_ARCHIVE_RULES } from '../../contract/cloud-archive';
import { CLOUD_LIGHT } from '../lightning/cloud-light';
import { lookedAt } from '../surface';

export { volumeFieldGlsl } from './field.glsl';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const KM_PER_DEGREE = (EARTH_RADIUS_KM * Math.PI) / 180;

/**
 * Texel sizes (km) of the nested windows: the three finest around the ground below the screen centre,
 * the others around the centre. The march reads the first five; the relief light reads all but the
 * first, which is baked only over storm tiles (ADR 0037).
 */
export const WINDOW_TEXEL_KM = [0.5, 1, 2, 4, 8, 16, 32] as const;
/** Windows the march reads. */
const MARCH_WINDOWS = 5;
/** Windows around the ground below the screen centre. */
const NEAR_WINDOWS = 3;
/** Detail level of the storm tiles, which the 0.5 km window waits for. */
const STORM_LEVEL = CLOUD_ARCHIVE_RULES.detail_storm_level;
/** Screen height (NDC) the two finest windows centre on, where oblique views magnify the ground. */
const NEAR_SCREEN_Y = -0.4;
/** Farthest (km) the two finest windows' centre may sit from the others', so the 2 km window stays inside the 4 km one. */
export const NEAR_MAX_KM = 400;
/** Camera heights (km) over which the volume replaces the flat layer. */
export const VOLUME_FADE_KM = [1800, 2800] as const;
/** Exaggeration of the styled tops' slopes in the sky each top sees; the heights themselves are not exaggerated. */
const RELIEF = 1.6;
/** Brightness of sunlit cloud for the many scatterings a capped column leaves out. */
const SCATTER_GAIN = 2;
/** Share of that gain kept under a high sun, so sunlit tops stay below white and show their relief. */
const NOON_EXPOSURE = 0.86;
/**
 * Relief light (ADR 0034): the broad slopes of the dense tops are drawn RELIEF_EXAGGERATION ×
 * texelKm^RELIEF_SCALE times steeper (3 in the 1 km window, 7 in the 32 km one), the same rule at
 * every height; slopes under RELIEF_CORE, compression noise rather than shape, are cored out.
 */
const RELIEF_EXAGGERATION = 3;
const RELIEF_SCALE = 0.25;
const RELIEF_CORE = 0.035;
/** Sine of the highest sun the relief light takes (45°), so a noon sun still shows the shape. */
const RELIEF_SUN_CAP = 0.71;
/** Widths (texels) of the broad shape and of its wider surroundings. */
const RELIEF_WIDTH_TEXELS = [1.5, 4] as const;
/** Share of the relief light's shading kept on screen, after the highlight shoulder. */
const RELIEF_STRENGTH = 0.7;
/** Direct light left on a top in the shadow of a taller cloud, in the flat layer. */
const RELIEF_SKY = 0.15;
/** Km per CSS pixel at the screen centre over which the relief fades out, as the 32 km window's texels shrink under 3.4 pixels. */
export const RELIEF_TOP_PX_KM = [19, 28] as const;
/** Cover of the 1 and 2 km windows sharpened against its ring of neighbours (ADR 0034): crisper small clouds, the same mean. */
const COVER_SHARPEN = 1;
/** Above the march, a window moves only once the view has moved this many of its texels. */
const FAR_SNAP_TEXELS = 32;

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
	const coarse = WINDOW_TEXEL_KM[MARCH_WINDOWS - 1] / KM_PER_DEGREE;
	const snappedLat = Math.round(latDeg / coarse) * coarse;
	const cos = Math.max(Math.round(Math.cos(Math.min(Math.abs(snappedLat), 72.7) * DEG) * 20) / 20, 0.3);
	const stepLon = stepLat / cos;
	const lat = Math.round(latDeg / stepLat) * stepLat;
	const lon = Math.round(lonDeg / stepLon) * stepLon;
	return { lat: lat * DEG, lon: lon * DEG, halfLat: ((texels * stepLat) / 2) * DEG, halfLon: ((texels * stepLon) / 2) * DEG };
}

/** `to` (degrees), moved along the great circle toward `from` until it is at most `maxKm` away. */
export function within(from: [number, number], to: [number, number], maxKm: number): [number, number] {
	const unit = ([lat, lon]: [number, number]) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.sin(lat * DEG), -Math.cos(lat * DEG) * Math.sin(lon * DEG)];
	const a = unit(from);
	const b = unit(to);
	const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
	const most = maxKm / EARTH_RADIUS_KM;
	if (angle <= most) return to;
	const sin = Math.sin(angle);
	const wa = Math.sin(angle - most) / sin;
	const wb = Math.sin(most) / sin;
	const p = a.map((v, i) => v * wa + b[i] * wb);
	return [Math.asin(Math.min(1, Math.max(-1, p[1]))) / DEG, Math.atan2(-p[2], p[0]) / DEG];
}

/** Great-circle distance (km) between two points (degrees). */
export function kmBetween([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]): number {
	const a = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
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

/** How much of the relief light and the shadows of taller clouds show at a footprint at the screen centre (km per CSS pixel). */
export function reliefFade(centrePxKm: number): number {
	const [a, b] = RELIEF_TOP_PX_KM;
	const t = Math.min(1, Math.max(0, (centrePxKm - a) / (b - a)));
	return 1 - t * t * (3 - 2 * t);
}

/**
 * Window to bake this frame among `from` and up: a missing one first, coarsest first; else, every
 * `every` frames, the next stale one in turn, so no window starves the others; else one in turn every
 * `refresh` frames, in case something unseen moved. -1 for none.
 */
export function windowToBake(missing: readonly boolean[], stale: () => readonly boolean[], from: number, frame: number, every: number, refresh: number): number {
	const count = missing.length - from;
	for (let k = missing.length - 1; k >= from; k--) if (missing[k]) return k;
	if (count <= 0 || frame % every !== 0) return -1;
	const changed = stale();
	const start = Math.floor(frame / every) % count;
	for (let i = 0; i < count; i++) {
		const k = from + ((start + i) % count);
		if (changed[k]) return k;
	}
	return frame % refresh === 0 ? from + (Math.floor(frame / refresh) % count) : -1;
}

/** Taps per side over each texel of window `k` for the heights and the cover, so coarse windows hold texel means. */
export function bakeTaps(k: number): [number, number] {
	return [[1, 1], [1, 1], [1, 1], [2, 1], [2, 2], [4, 2], [8, 4]][k] as [number, number];
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
	/** Finest detail level loaded at a point (degrees), 0 for none: the 0.5 km window waits for storm tiles. */
	levelAt?: (latDeg: number, lonDeg: number) => number;
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
	/** March resolution (share of the CSS size) and most crossings per ray, when the quality tier changes. */
	setQuality(quality: { scale: number; maxSamples: number }): void;
	/** Share of each reduced pixel the clouds cover, for development checks. */
	coverage(renderer: WebGLRenderer): { width: number; height: number; values: Float32Array };
	/** How far the styling strays from the observations over window `k` (the 1 km one by default), for development checks. */
	styleCheck(renderer: WebGLRenderer, k?: number): StyleBounds;
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
	levelAt = () => 0,
}: CloudVolumeOptions): CloudVolume {
	// Field and observations in half floats: 8 bits would step the tops by 78 m, which the light turns into contour lines.
	const field = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: HalfFloatType });
	const sun = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: UnsignedByteType });
	const raw = new WebGLRenderTarget(texels, texels, { depthBuffer: false, type: HalfFloatType });
	// The relief light of every window and the sunlit share of its tops, and their spread tops on the way.
	const reliefLight = new WebGLArrayRenderTarget(texels, texels, WINDOW_TEXEL_KM.length, { depthBuffer: false, type: HalfFloatType });
	const spread = new WebGLRenderTarget(texels, texels, { depthBuffer: false, type: HalfFloatType });
	for (const target of [field, sun, raw, reliefLight, spread]) {
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
		volumeCount: { value: MARCH_WINDOWS },
		volumeOn: { value: 0 },
		volumeRelief: { value: reliefLight.texture },
		reliefOn: { value: 0 },
		reliefKmPerUnit: { value: 0 },
		reliefSky: { value: RELIEF_SKY },
		volumeMaxOpacity: { value: VOLUME_MAX_OPACITY },
		volumeKnee: { value: VOLUME_KNEE },
		volumeVeilOpacity: { value: VEIL_MAX_OPACITY },
	};
	const bakeWindow = { value: new Vector4() };
	const bakeTexels = { value: texels };
	const sunDir = { value: new Vector3(1, 0, 0) };
	const lightGain = { value: 2.5 };

	const pass = (fragmentShader: string, passUniforms: Record<string, IUniform>, defines: Record<string, string> = {}) =>
		new ShaderMaterial({ vertexShader: passVertexShader, fragmentShader, uniforms: passUniforms, defines, depthTest: false, depthWrite: false });
	const taps = { value: new Vector2(1, 1) };
	const rawMaterial = pass(
		rawFieldFragmentShader,
		{ ...opacity.uniforms, ...heights, bakeWindow, bakeTexels, bakeTaps: taps },
		{ ...opacity.defines, ...(Object.keys(heights).length > 0 ? { HEIGHTS: '' } : {}) },
	);
	const styleUniforms: Record<string, IUniform> = {
		rawField: { value: raw.texture },
		bakeWindow,
		bakeTexels,
		texelKm: { value: 1 },
		styled: { value: detail ? 1 : 0 },
		coverSharpen: { value: detail ? COVER_SHARPEN : 0 },
		sunDir,
	};
	const styleMaterial = pass(styleFragmentShader, styleUniforms);
	const skyViewOn = { value: 0 };
	const groundOn = { value: 1 };
	const sunMaterial = pass(sunFragmentShader, { ...uniforms, bakeWindow, sunDir, lightGain, skyViewOn, groundOn });
	const spreadUniforms: Record<string, IUniform> = {
		volumeField: { value: field.texture },
		spreadSource: { value: raw.texture },
		spreadLayer: { value: 0 },
		spreadStep: { value: new Vector2() },
		spreadWidth: { value: new Vector2(1, 1) },
	};
	const spreadMaterial = pass(spreadFragmentShader, spreadUniforms);
	const reliefExaggeration = { value: detail ? RELIEF_EXAGGERATION : 0 };
	const bakeLayer = { value: 0 };
	const reliefMaterial = pass(reliefFragmentShader, {
		spread: { value: spread.texture },
		volumeField: { value: field.texture },
		volumeSun: { value: sun.texture },
		bakeLayer,
		bakeWindow,
		bakeTexels,
		texelKm: styleUniforms.texelKm,
		sunDir,
		reliefStrength: { value: RELIEF_STRENGTH },
		reliefExaggeration,
		reliefScalePow: { value: RELIEF_SCALE },
		reliefCore: { value: RELIEF_CORE },
		reliefSunCap: { value: RELIEF_SUN_CAP },
	});
	const reliefPixelAngle = { value: 0.001 };
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
		noonExposure: { value: NOON_EXPOSURE },
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
			...uniforms,
			rayMatrix,
			eyeKm,
			sunDir,
			reliefPixelAngle,
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
	// Above the march, coarser steps of blend and sun: far shading changes little between them.
	const inputs = (far: boolean) => [
		versionOf(opacity.uniforms.cloudMap),
		versionOf(opacity.uniforms.cloudMapNext),
		Math.round((opacity.uniforms.cloudMix?.value ?? 0) * (far ? 8 : 64)),
		versionOf(opacity.uniforms.detailPagesA),
		versionOf(opacity.uniforms.detailPagesB),
		versionOf(heights.heightPagesA),
		versionOf(heights.heightPagesB),
		sunDir.value.toArray().map((v) => Math.round(v * (far ? 100 : 1000))).join(','),
		styleUniforms.styled.value,
	].join('|');
	const signatures: string[] = WINDOW_TEXEL_KM.map(() => '');
	// The same with the coarser steps used above the march, so crossing 2,800 km bakes nothing again.
	const farSignatures: string[] = WINDOW_TEXEL_KM.map(() => '');
	const signature = (k: number, latDeg: number, lonDeg: number, shared: string) => {
		const w = windowAround(latDeg, lonDeg, k, texels);
		return `${w.lat.toFixed(6)},${w.lon.toFixed(6)}|${shared}`;
	};

	// Where each window was last baked: above the march a window stays until the view has moved far enough.
	const placed: ([number, number] | null)[] = WINDOW_TEXEL_KM.map(() => null);
	const empty = (k: number) => {
		windows[k].set(0, 0, 1e-6, 1e-6);
		signatures[k] = '';
		farSignatures[k] = '';
		placed[k] = null;
	};

	// Observations, then their styling, then the sunlight through the styled columns, then the light
	// of the broad shape.
	const bake = (renderer: WebGLRenderer, k: number, latDeg: number, lonDeg: number) => {
		signatures[k] = signature(k, latDeg, lonDeg, inputs(false));
		farSignatures[k] = signature(k, latDeg, lonDeg, inputs(true));
		placed[k] = [latDeg, lonDeg];
		const w = windowAround(latDeg, lonDeg, k, texels);
		windows[k].set(w.lat, w.lon, w.halfLat, w.halfLon);
		bakeWindow.value.copy(windows[k]);
		styleUniforms.texelKm.value = WINDOW_TEXEL_KM[k];
		taps.value.set(...bakeTaps(k));
		skyViewOn.value = k < NEAR_WINDOWS ? 1 : 0;
		// Only the march's windows give the ground its shadows; the 16 km one reads itself for its tops.
		const count = uniforms.volumeCount.value;
		groundOn.value = k < MARCH_WINDOWS && uniforms.volumeOn.value > 0 ? 1 : 0;
		if (k >= MARCH_WINDOWS) uniforms.volumeCount.value = WINDOW_TEXEL_KM.length;
		draw(renderer, rawMaterial, raw);
		draw(renderer, styleMaterial, field, k);
		draw(renderer, sunMaterial, sun, k);
		uniforms.volumeCount.value = count;
		// The relief light never reads the 0.5 km window.
		if (k === 0) return;
		// Dense tops spread across, then along (through the free observations target), then lit.
		spreadUniforms.spreadWidth.value.set(...RELIEF_WIDTH_TEXELS);
		spreadUniforms.spreadLayer.value = k;
		spreadUniforms.spreadSource.value = spread.texture;
		spreadUniforms.spreadStep.value.set(1 / texels, 0);
		draw(renderer, spreadMaterial, raw);
		spreadUniforms.spreadLayer.value = -1;
		spreadUniforms.spreadSource.value = raw.texture;
		spreadUniforms.spreadStep.value.set(0, 1 / texels);
		draw(renderer, spreadMaterial, spread);
		bakeLayer.value = k;
		draw(renderer, reliefMaterial, reliefLight, k);
	};

	const volume: CloudVolume = {
		mesh,
		uniforms,
		get fade() { return fadeUniform.value; },
		get detail() { return styleUniforms.styled.value > 0.5; },
		set detail(on: boolean) {
			styleUniforms.styled.value = on ? 1 : 0;
			marchUniforms.relief.value = on ? RELIEF : 1;
			reliefExaggeration.value = on ? RELIEF_EXAGGERATION : 0;
			styleUniforms.coverSharpen.value = on ? COVER_SHARPEN : 0;
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
			const fov = (camera as Camera & { fov?: number }).fov ?? 35;
			const cssAngle = (2 * Math.tan((fov * DEG) / 2)) / Math.max(1, view.height);
			// The points looked at: the ground at a screen height, never further than the point seen at the
			// steepest tilt (`lookedAt`). The coarse windows centre on the screen centre; the fine ones lower
			// down, where the nearer ground is magnified. `slant` keeps the distance (km) to the last one.
			let slant = 0;
			const groundAt = (ndcY: number): [number, number] => {
				dir.set(0, ndcY, 0.5).unproject(camera as Camera & { projectionMatrixInverse: Matrix4 }).applyMatrix4(earthInverse).sub(eye).normalize();
				lookedAt(eye, dir, 1, look);
				slant = look.distanceTo(eye) * EARTH_RADIUS_KM;
				return [Math.asin(look.y) / DEG, Math.atan2(-look.z, look.x) / DEG];
			};
			const centre = groundAt(0);
			const shown = (opacity.uniforms.cloudShown?.value ?? 0) > 0.5;
			const fade = shown ? volumeFade(heightKm) : 0;
			const relief = shown ? reliefFade(slant * cssAngle) : 0;
			const marching = fade > 0;
			fadeUniform.value = fade;
			uniforms.volumeOn.value = fade;
			uniforms.reliefOn.value = relief;
			mesh.visible = marching;
			if (!marching && relief <= 0) {
				lastViewProjection = null;
				baked = 0;
				return;
			}
			reliefPixelAngle.value = cssAngle;
			uniforms.reliefKmPerUnit.value = kmPerUnit * cssAngle;
			const target = renderer.getRenderTarget();
			const autoClear = renderer.autoClear;
			renderer.autoClear = false;
			const near = within(centre, groundAt(NEAR_SCREEN_Y), NEAR_MAX_KM);
			const pointFor = (k: number) => (k < NEAR_WINDOWS ? near : centre);
			// The 16 km window, and above the march every coarse one, moves only once the view has gone a good way.
			const wanted = (k: number): [number, number] => {
				const q = placed[k];
				return q && (k >= MARCH_WINDOWS || !marching) && kmBetween(q, centre) < FAR_SNAP_TEXELS * WINDOW_TEXEL_KM[k] ? q : pointFor(k);
			};
			sunDir.value.copy(view.sun).normalize();

			if (!marching) {
				// Above the march only the coarse windows the relief reads are baked, coarsest first, one
				// at a time, and they move only once the view has gone a good way.
				if (uniforms.volumeCount.value !== WINDOW_TEXEL_KM.length) {
					uniforms.volumeCount.value = WINDOW_TEXEL_KM.length;
					baked = 0;
				}
				lastViewProjection = null;
				groundAt(-1);
				// The finest window the relief reads at the bottom of the screen, where pixels are smallest.
				const first = Math.min(5, Math.max(3, Math.floor(Math.log2(3.4 * slant * cssAngle)) + 1));
				for (let k = 0; k < first; k++) if (placed[k] || signatures[k]) empty(k);
				const shared = inputs(true);
				const missing = signatures.map((sig) => !sig);
				const next = windowToBake(missing, () => WINDOW_TEXEL_KM.map((_, k) => farSignatures[k] !== signature(k, ...wanted(k), shared)), first, baked, 4, 128);
				if (next >= 0) bake(renderer, next, ...wanted(next));
				baked++;
				renderer.setRenderTarget(target);
				renderer.autoClear = autoClear;
				return;
			}

			// The march's windows at once after a jump; then, every other frame, the next window whose inputs
			// changed, and one anyway every 32 frames. The coarser windows join them while the relief shows.
			if (uniforms.volumeCount.value !== MARCH_WINDOWS) {
				uniforms.volumeCount.value = MARCH_WINDOWS;
				baked = 0;
			}
			const shared = inputs(false);
			const count = relief > 0 ? WINDOW_TEXEL_KM.length : MARCH_WINDOWS;
			if (count === MARCH_WINDOWS && placed[MARCH_WINDOWS]) empty(MARCH_WINDOWS);
			const storm = Math.max(levelAt(...near), levelAt(...centre)) >= STORM_LEVEL;
			if (!storm && (placed[0] || signatures[0])) empty(0);
			const from = storm ? 0 : 1;
			if (baked === 0) {
				for (let k = MARCH_WINDOWS - 1; k >= from; k--) bake(renderer, k, ...pointFor(k));
			} else {
				const missing = signatures.slice(0, count).map((sig, k) => k >= from && !sig);
				const stale = () => missing.map((_, k) => k >= from && signatures[k] !== signature(k, ...wanted(k), shared));
				const next = windowToBake(missing, stale, from, baked, 2, 32);
				if (next >= 0) bake(renderer, next, ...wanted(next));
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
			marchUniforms.pixelAngle.value = (2 * Math.tan((fov * DEG) / 2)) / height;
			resolveUniforms.freshSize.value.set(fresh.width, fresh.height);
			phase.value.set(...marchPhase(frame));
			// Golden-ratio steps: each pixel's offset visits the whole step evenly over a few frames.
			marchUniforms.frameJitter.value = ((Math.floor(frame / 4) * 0.618034) % 1 + 1) % 1;
			marchUniforms.subPixel.value.set(halton(Math.floor(frame / 4) + 1, 2) - 0.5, halton(Math.floor(frame / 4) + 1, 3) - 0.5);
			marchUniforms.flashLight.value = view.light?.map ?? null;
			if (view.light) marchUniforms.flashWindow.value = view.light.window;
			marchUniforms.flashGain.value = view.light ? CLOUD_LIGHT.gain : 0;
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
		styleCheck(renderer, k = 1) {
			if (!placed[k]) throw new Error('styleCheck needs the march: bring the camera below 2,800 km');
			const target = renderer.getRenderTarget();
			bakeWindow.value.copy(windows[k]);
			styleUniforms.texelKm.value = WINDOW_TEXEL_KM[k];
			taps.value.set(...bakeTaps(k));
			const styled = new WebGLRenderTarget(texels, texels, { depthBuffer: false, type: HalfFloatType });
			draw(renderer, rawMaterial, raw);
			draw(renderer, styleMaterial, styled);
			const read = (from: WebGLRenderTarget) => {
				const half = new Uint16Array(texels * texels * 4);
				renderer.readRenderTargetPixels(from, 0, 0, texels, texels, half);
				return Float32Array.from(half, (h) => DataUtils.fromHalfFloat(h));
			};
			const bounds = styleBounds(read(raw), read(styled), texels, WINDOW_TEXEL_KM[k]);
			styled.dispose();
			renderer.setRenderTarget(target);
			return bounds;
		},
		dispose() {
			for (const t of [field, sun, raw, reliefLight, spread, fresh, ...history]) t.dispose();
			for (const m of [rawMaterial, styleMaterial, sunMaterial, spreadMaterial, reliefMaterial, marchMaterial, resolveMaterial, composite]) m.dispose();
			quad.geometry.dispose();
			mesh.geometry.dispose();
		},
	};
	return volume;
}
