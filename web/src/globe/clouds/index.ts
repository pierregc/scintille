import { Color, FrontSide, type IUniform, Mesh, ShaderMaterial, SphereGeometry, type Texture, Vector2, Vector3, Vector4 } from 'three';
import { sunDirection } from '../sun';
import { twilightUniforms } from '../twilight';
import { cloudsFragmentShader, cloudsVertexShader } from './clouds.glsl';
import type { CloudDetail, DetailSource } from './detail';
import type { CloudFrame } from './frame';
import { browserStorage, type PreferenceStorage, readCloudsVisible, writeCloudsVisible } from './preference';
import { blendPair, easePosition, framePosition, MAX_CLOUD_FRAMES } from './timeline';

export { cloudOpacityGlsl } from './clouds.glsl';
export { type CloudFrame, loadCloudFrame } from './frame';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** Shell height: just under the lightning cloud tops (12 km), so flashes sit on the clouds. */
export const CLOUD_SHELL_KM = 10;

/** GMGSI covers 72.7° S to 72.7° N (ADR 0007); the layer fades out before that edge. */
export const CLOUD_FADE_LATITUDES = [66, 72.7] as const;

/** Draws before the atmosphere (0) so it hazes the clouds, and before lightning (1). */
export const CLOUDS_RENDER_ORDER = -1;

const FLASH_GAIN = 5;

/** Beyond this distance from every frame, the scene time has no honest cloud picture: the layer hides. */
export const CLOUD_MAX_GAP_MS = 3 * 3_600_000;

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
	/** Frames kept on the GPU. */
	maxFrames?: number;
	/** Finer tiles near the camera, when the frames have them. */
	detail?: CloudDetail;
}

export interface Clouds {
	mesh: Mesh;
	readonly visible: boolean;
	/** Observation time (UTC ms) of the frame mostly shown, or null when none is shown. */
	readonly frameTime: number | null;
	/** Observation times of the frames held, ascending. */
	readonly frameTimes: readonly number[];
	/**
	 * Adds a frame to the timeline; the layer crossfades between the frames around the scene time.
	 * It owns the texture: a frame with the same time replaces it, the oldest beyond the limit are disposed.
	 */
	setFrame(frame: CloudFrame): void;
	/** Keep only these observation times, disposing every other texture. */
	retainFrames(times: readonly number[]): void;
	/** Turns the layer on or off and remembers the choice. */
	setVisible(visible: boolean): void;
	/** Points the sun at its position for a UTC instant in milliseconds. */
	setTime(utcMs: number): void;
	/** Flash glow map over a window of the globe that lights the clouds from inside; null turns it off. */
	setFlashLight(light: { map: Texture; window: Vector4 } | null): void;
	/** Detail tiles of the two frames being blended, while the layer shows. */
	detailFrames(): readonly [DetailSource | null, DetailSource | null];
	/**
	 * What another material needs to read the cloud opacity: share these uniforms and defines and
	 * include `cloudOpacityGlsl`. They follow the layer: frames, blend, detail and visibility.
	 */
	readonly opacity: { uniforms: Record<string, IUniform>; defines: Record<string, string> };
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
		maxFrames = MAX_CLOUD_FRAMES,
		detail,
	}: CloudsOptions = {},
): Clouds {
	const geometry = new SphereGeometry(cloudShellRadius(radius, altitudeKm), widthSegments, heightSegments);
	const twilight = twilightUniforms();
	const opacity = {
		uniforms: {
			cloudMap: { value: null as Texture | null },
			cloudMapNext: { value: null as Texture | null },
			cloudMix: { value: 0 },
			cloudMaxOpacity: { value: 0.92 },
			cloudFadeLatitudes: { value: new Vector2(...CLOUD_FADE_LATITUDES.map((lat) => Math.sin(lat * DEG))) },
			cloudShown: { value: 0 },
			...detail?.uniforms,
		},
		defines: { ...(bicubic ? { BICUBIC: '' } : {}), ...(detail ? { DETAIL: '' } : {}) },
	};
	const material = new ShaderMaterial({
		vertexShader: cloudsVertexShader,
		fragmentShader: cloudsFragmentShader,
		uniforms: {
			...opacity.uniforms,
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
			limbThickening: { value: 0.6 },
			flashLight: { value: null },
			flashWindow: { value: new Vector4(0, 0, Math.PI, Math.PI / 2) },
			flashColor: { value: new Color('#dfe6ff') },
			flashGain: { value: 0 },
		},
		defines: opacity.defines,
		side: FrontSide,
		transparent: true,
		depthWrite: false,
	});
	const mesh = new Mesh(geometry, material);
	mesh.renderOrder = CLOUDS_RENDER_ORDER;

	const frames: CloudFrame[] = [];
	let position = Number.NaN;
	let sceneTime = Number.NaN;
	let visible = readCloudsVisible(storage);
	let disposed = false;
	const covered = () =>
		frames.length > 0 &&
		(!Number.isFinite(sceneTime) || frames.some((f) => Math.abs(f.time - sceneTime) <= CLOUD_MAX_GAP_MS));
	const syncVisibility = () => {
		mesh.visible = visible && covered();
		opacity.uniforms.cloudShown.value = mesh.visible ? 1 : 0;
	};
	syncVisibility();

	const target = () =>
		Number.isFinite(sceneTime) ? framePosition(frames.map((f) => f.time), sceneTime) : frames.length - 1;

	const shownTime = () => {
		const { a, b, mix } = blendPair(position, frames.length);
		return frames[a].time + (frames[b].time - frames[a].time) * mix;
	};

	const show = () => {
		if (frames.length === 0) return;
		const { a, b, mix } = blendPair(position, frames.length);
		material.uniforms.cloudMap.value = frames[a].texture;
		material.uniforms.cloudMapNext.value = frames[b].texture;
		material.uniforms.cloudMix.value = mix;
	};

	return {
		mesh,
		opacity,
		get visible() {
			return visible;
		},
		get frameTime() {
			if (!covered()) return null;
			return frames[Math.min(Math.round(position), frames.length - 1)].time;
		},
		get frameTimes() {
			return frames.map((f) => f.time);
		},
		setFrame(next) {
			if (disposed) return next.texture.dispose();
			next.texture.anisotropy = Math.min(anisotropy, maxAnisotropy);
			next.texture.needsUpdate = true;
			const shown = mesh.visible ? shownTime() : Number.NaN;
			const same = frames.findIndex((f) => f.time === next.time);
			if (same >= 0) {
				if (frames[same].texture !== next.texture) frames[same].texture.dispose();
				frames[same] = next;
			} else {
				frames.push(next);
				frames.sort((x, y) => x.time - y.time);
			}
			while (frames.length > Math.max(maxFrames, 1)) frames.shift()?.texture.dispose();
			// Keep showing the same instant, if any is on screen; the next setTime eases toward the new target.
			position = Number.isFinite(shown) ? framePosition(frames.map((f) => f.time), shown) : target();
			show();
			syncVisibility();
		},
		retainFrames(times) {
			const shown = mesh.visible && frames.length > 0 ? shownTime() : Number.NaN;
			for (let i = frames.length - 1; i >= 0; i--) {
				if (!times.includes(frames[i].time)) frames.splice(i, 1)[0].texture.dispose();
			}
			position = Number.isFinite(shown) && frames.length > 0 ? framePosition(frames.map((f) => f.time), shown) : target();
			if (frames.length === 0) {
				material.uniforms.cloudMap.value = null;
				material.uniforms.cloudMapNext.value = null;
			} else show();
			syncVisibility();
		},
		setVisible(next) {
			visible = next;
			writeCloudsVisible(storage, next);
			syncVisibility();
		},
		setTime(utcMs) {
			material.uniforms.sunDirection.value.set(...sunDirection(new Date(utcMs)));
			// Eases on scene time, so a paused or rendered clock gives the same picture every time.
			const previous = sceneTime;
			sceneTime = utcMs;
			syncVisibility();
			if (frames.length === 0) return;
			position = Number.isFinite(previous)
				? easePosition(position, target(), Math.abs(utcMs - previous) / 1000)
				: target();
			show();
		},
		detailFrames() {
			if (!mesh.visible || frames.length === 0) return [null, null];
			const { a, b } = blendPair(position, frames.length);
			return [frames[a].detail ?? null, frames[b].detail ?? null];
		},
		setFlashLight(light) {
			material.uniforms.flashLight.value = light?.map ?? null;
			if (light) material.uniforms.flashWindow.value = light.window;
			material.uniforms.flashGain.value = light ? FLASH_GAIN : 0;
		},
		dispose() {
			disposed = true;
			for (const f of frames.splice(0)) f.texture.dispose();
			geometry.dispose();
			material.dispose();
		},
	};
}
