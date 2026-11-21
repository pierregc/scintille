import { ClampToEdgeWrapping, LinearFilter, NoColorSpace, type PerspectiveCamera, RepeatWrapping, RGFormat, type Scene, Texture, Vector2, type WebGLRenderer } from 'three';
import { WIND_RULES } from '../../contract/wind';
import { worldToKm } from '../flight';
import { sunDirection } from '../sun';
import { createWindLayer, type WindLayerSetup } from './layer';
import { WIND_LOOK_LEVEL, type WindLevel, type WindLook } from './types';

/** NOAA NCEP GFS fields valid 2026-11-21 13:00 UTC, laid out as the clouds service publishes them (ADR 0039). */
export const WIND_FIXTURE_TIME = Date.UTC(2026, 10, 21, 13);

export function windFixturePath(level: WindLevel): string {
	return `archive/wind/${level}/2026/11/21/20261121T130000Z.webp`;
}

/** Uploads a wind frame as the feed does: 90° N at v = 1, red and green only, no mipmaps. */
async function loadWindTexture(url: string): Promise<Texture> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`wind fixture ${response.status}`);
	const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
	const texture = new Texture(bitmap, undefined, RepeatWrapping, ClampToEdgeWrapping, LinearFilter, LinearFilter, RGFormat);
	texture.colorSpace = NoColorSpace;
	texture.generateMipmaps = false;
	texture.flipY = false;
	texture.needsUpdate = true;
	return texture;
}

/** `?wind=jet|surface`. */
export function windLookFromSearch(search: string): WindLook | null {
	const value = new URLSearchParams(search).get('wind');
	return value === 'jet' || value === 'surface' ? value : null;
}

export interface DevWindOptions extends WindLayerSetup {
	search: string;
	scene: Scene;
	renderer: WebGLRenderer;
	/** Where the fixtures are served, like R2. */
	baseUrl: string;
	/** Scene time, UTC ms. */
	time: () => number;
	steady: () => boolean;
	stormView: () => boolean;
}

/** Dev only: `?wind=jet|surface` draws the fixture field until the feed exists, updated as the scene renders. */
export function attachDevWind({ search, scene, renderer, baseUrl, time, steady, stormView, ...setup }: DevWindOptions): void {
	const look = windLookFromSearch(search);
	if (!look) return;
	const layer = createWindLayer(setup);
	layer.setLook(look);
	scene.add(layer.object);
	const level = WIND_LOOK_LEVEL[look];
	loadWindTexture(new URL(windFixturePath(level), baseUrl).href).then((texture) => {
		layer.setFields({ time: WIND_FIXTURE_TIME, level, texture, scaleMs: WIND_RULES.levels[level].scale_ms }, null, 0);
	}, (error: unknown) => console.warn('wind fixture:', error));

	const size = new Vector2();
	const previous = scene.onBeforeRender;
	scene.onBeforeRender = (...args) => {
		previous.apply(scene, args);
		const camera = args[2] as PerspectiveCamera;
		// The bloom pass renders the same scene with only its own layer.
		if (!camera.isPerspectiveCamera || !camera.layers.test(layer.object.layers)) return;
		const heightKm = worldToKm(camera.position.length() - setup.radius, setup.radius);
		const kmPerPx = (2 * heightKm * Math.tan((camera.fov * Math.PI) / 360)) / renderer.getSize(size).y;
		layer.update({ renderer, kmPerPx, wallMs: performance.now(), sun: sunDirection(new Date(time())), steady: steady(), stormView: stormView() });
	};
}
