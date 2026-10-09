import { Color, FrontSide, Mesh, ShaderMaterial, SphereGeometry, type Texture, Vector2, Vector3, Vector4 } from 'three';
import { sunDirection } from '../sun';
import { twilightUniforms } from '../twilight';
import { cloudsFragmentShader, cloudsVertexShader } from './clouds.glsl';
import type { CloudFrame } from './frame';
import { browserStorage, type PreferenceStorage, readCloudsVisible, writeCloudsVisible } from './preference';
import { blendPair, easePosition, framePosition, MAX_CLOUD_FRAMES } from './timeline';

export { CLOUD_FIXTURE, type CloudFrame, cloudFixtureUrl, loadCloudFrame } from './frame';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** Shell height: just under the lightning cloud tops (12 km), so flashes sit on the clouds. */
export const CLOUD_SHELL_KM = 10;

/** GMGSI covers 72.7° S to 72.7° N (ADR 0007); the layer fades out before that edge. */
export const CLOUD_FADE_LATITUDES = [66, 72.7] as const;

/** Draws before the atmosphere (0) so it hazes the clouds, and before lightning (1). */
export const CLOUDS_RENDER_ORDER = -1;

const FLASH_GAIN = 5;

export interface CloudsOptions {
	radius?: number;
	altitudeKm?: number;
	widthSegments?: number;
	heightSegments?: number;
	/** Texture anisotropy; capped by the GPU. */
	anisotropy?: number;
	/** Smooth cubic filtering (four taps instead of one). */
	bicubic?: boolean;
	/** Where the on/off choice persists; null keeps it in memory only. */
	storage?: PreferenceStorage | null;
	/** Wall clock in milliseconds, for crossfades. */
	now?: () => number;
}

export interface Clouds {
	mesh: Mesh;
	readonly visible: boolean;
	/** Observation time (UTC ms) of the frame mostly shown, or null before the first frame. */
	readonly frameTime: number | null;
	/**
	 * Adds a frame to the timeline; the layer crossfades between the frames around the scene time.
	 * It owns the texture: a frame with the same time replaces it, the oldest beyond the limit are disposed.
	 */
	setFrame(frame: CloudFrame): void;
	/** Turns the layer on or off and remembers the choice. */
	setVisible(visible: boolean): void;
	/** Points the sun at its position for a UTC instant in milliseconds. */
	setTime(utcMs: number): void;
	/** Flash glow map in Earth UV space that lights the clouds from inside; null turns it off. */
	setFlashLight(map: Texture | null): void;
	dispose(): void;
}

export function cloudShellRadius(radius: number, altitudeKm = CLOUD_SHELL_KM): number {
	return radius * (1 + altitudeKm / EARTH_RADIUS_KM);
}

/** Cloud opacity shell above the Earth; add it as a child of the Earth mesh. */
export function createClouds(
	maxAnisotropy: number,
	{
		radius = 1,
		altitudeKm = CLOUD_SHELL_KM,
		widthSegments = 128,
		heightSegments = 64,
		anisotropy = 8,
		bicubic = true,
		storage = browserStorage(),
		now = () => performance.now(),
	}: CloudsOptions = {},
): Clouds {
	const geometry = new SphereGeometry(cloudShellRadius(radius, altitudeKm), widthSegments, heightSegments);
	const twilight = twilightUniforms();
	const material = new ShaderMaterial({
		vertexShader: cloudsVertexShader,
		fragmentShader: cloudsFragmentShader,
		uniforms: {
			cloudMap: { value: null },
			cloudMapNext: { value: null },
			cloudMix: { value: 0 },
			cloudMapSize: { value: new Vector2(1, 1) },
			sunDirection: { value: new Vector3(1, 0, 0) },
			twilightEdges: { value: new Vector4(...twilight.edges) },
			twilightWeights: { value: new Vector4(...twilight.weights) },
			twilightSoftness: { value: twilight.softness },
			sunDip: { value: Math.sin(Math.acos(1 / (1 + altitudeKm / EARTH_RADIUS_KM))) },
			dayColor: { value: new Color(0.93, 0.94, 0.96) },
			twilightColor: { value: new Color(0.03, 0.036, 0.05) },
			nightColor: { value: new Color(0.006, 0.007, 0.01) },
			warmTint: { value: new Color(1.6, 0.8, 0.45) },
			terminatorTint: { value: 0.8 },
			maxOpacity: { value: 0.92 },
			limbThickening: { value: 0.6 },
			fadeLatitudes: { value: new Vector2(...CLOUD_FADE_LATITUDES.map((lat) => Math.sin(lat * DEG))) },
			flashLight: { value: null },
			flashColor: { value: new Color('#dfe6ff') },
			flashGain: { value: 0 },
		},
		defines: bicubic ? { BICUBIC: '' } : {},
		side: FrontSide,
		transparent: true,
		depthWrite: false,
	});
	const mesh = new Mesh(geometry, material);
	mesh.renderOrder = CLOUDS_RENDER_ORDER;

	const frames: CloudFrame[] = [];
	let position = Number.NaN;
	let sceneTime = Number.NaN;
	let lastWall = Number.NaN;
	let visible = readCloudsVisible(storage);
	let disposed = false;
	const syncVisibility = () => {
		mesh.visible = visible && frames.length > 0;
	};
	syncVisibility();

	const target = () =>
		Number.isFinite(sceneTime) ? framePosition(frames.map((f) => f.time), sceneTime) : frames.length - 1;

	const show = () => {
		if (frames.length === 0) return;
		const { a, b, mix } = blendPair(position, frames.length);
		const image = frames[a].texture.image as { width: number; height: number };
		material.uniforms.cloudMap.value = frames[a].texture;
		material.uniforms.cloudMapNext.value = frames[b].texture;
		material.uniforms.cloudMix.value = mix;
		material.uniforms.cloudMapSize.value.set(image.width, image.height);
	};

	return {
		mesh,
		get visible() {
			return visible;
		},
		get frameTime() {
			if (frames.length === 0) return null;
			return frames[Math.min(Math.round(position), frames.length - 1)].time;
		},
		setFrame(next) {
			if (disposed) return next.texture.dispose();
			next.texture.anisotropy = Math.min(anisotropy, maxAnisotropy);
			next.texture.needsUpdate = true;
			const shown = frames.length > 0 ? frames[Math.round(position)]?.time : undefined;
			const same = frames.findIndex((f) => f.time === next.time);
			if (same >= 0) {
				if (frames[same].texture !== next.texture) frames[same].texture.dispose();
				frames[same] = next;
			} else {
				frames.push(next);
				frames.sort((x, y) => x.time - y.time);
			}
			while (frames.length > MAX_CLOUD_FRAMES) frames.shift()?.texture.dispose();
			// Keep showing the same frame; the next setTime eases toward the new target.
			const kept = shown === undefined ? -1 : frames.findIndex((f) => f.time === shown);
			position = kept >= 0 ? kept + (position - Math.round(position)) : target();
			show();
			syncVisibility();
		},
		setVisible(next) {
			visible = next;
			writeCloudsVisible(storage, next);
			syncVisibility();
		},
		setTime(utcMs) {
			material.uniforms.sunDirection.value.set(...sunDirection(new Date(utcMs)));
			sceneTime = utcMs;
			const wall = now();
			const dt = Number.isFinite(lastWall) ? (wall - lastWall) / 1000 : 0;
			lastWall = wall;
			if (frames.length === 0) return;
			position = easePosition(position, target(), dt);
			show();
		},
		setFlashLight(map) {
			material.uniforms.flashLight.value = map;
			material.uniforms.flashGain.value = map ? FLASH_GAIN : 0;
		},
		dispose() {
			disposed = true;
			for (const f of frames.splice(0)) f.texture.dispose();
			geometry.dispose();
			material.dispose();
		},
	};
}
