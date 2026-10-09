import { Color, FrontSide, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3, Vector4 } from 'three';
import { sunDirection } from '../sun';
import { twilightUniforms } from '../twilight';
import { cloudsFragmentShader, cloudsVertexShader } from './clouds.glsl';
import type { CloudFrame } from './frame';
import { browserStorage, type PreferenceStorage, readCloudsVisible, writeCloudsVisible } from './preference';

export { CLOUD_FIXTURE, type CloudFrame, cloudFixtureUrl, loadCloudFrame } from './frame';

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/** Shell height: just under the lightning cloud tops (12 km), so flashes sit on the clouds. */
export const CLOUD_SHELL_KM = 10;

/** GMGSI covers 72.7° S to 72.7° N (ADR 0007); the layer fades out before that edge. */
export const CLOUD_FADE_LATITUDES = [66, 72.7] as const;

/** Draws before the atmosphere (0) so it hazes the clouds, and before lightning (1). */
export const CLOUDS_RENDER_ORDER = -1;

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
}

export interface Clouds {
	mesh: Mesh;
	readonly visible: boolean;
	/** Observation time (UTC ms) of the frame shown, or null before the first frame. */
	readonly frameTime: number | null;
	/** Shows a frame; the layer takes ownership of its texture and disposes the previous one. */
	setFrame(frame: CloudFrame): void;
	/** Turns the layer on or off and remembers the choice. */
	setVisible(visible: boolean): void;
	/** Points the sun at its position for a UTC instant in milliseconds. */
	setTime(utcMs: number): void;
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
	}: CloudsOptions = {},
): Clouds {
	const geometry = new SphereGeometry(cloudShellRadius(radius, altitudeKm), widthSegments, heightSegments);
	const twilight = twilightUniforms();
	const material = new ShaderMaterial({
		vertexShader: cloudsVertexShader,
		fragmentShader: cloudsFragmentShader,
		uniforms: {
			cloudMap: { value: null },
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
		},
		defines: bicubic ? { BICUBIC: '' } : {},
		side: FrontSide,
		transparent: true,
		depthWrite: false,
	});
	const mesh = new Mesh(geometry, material);
	mesh.renderOrder = CLOUDS_RENDER_ORDER;

	let frame: CloudFrame | null = null;
	let visible = readCloudsVisible(storage);
	let disposed = false;
	const syncVisibility = () => {
		mesh.visible = visible && frame !== null;
	};
	syncVisibility();

	return {
		mesh,
		get visible() {
			return visible;
		},
		get frameTime() {
			return frame?.time ?? null;
		},
		setFrame(next) {
			if (disposed) return next.texture.dispose();
			if (frame && frame.texture !== next.texture) frame.texture.dispose();
			next.texture.anisotropy = Math.min(anisotropy, maxAnisotropy);
			next.texture.needsUpdate = true;
			const image = next.texture.image as { width: number; height: number };
			material.uniforms.cloudMap.value = next.texture;
			material.uniforms.cloudMapSize.value.set(image.width, image.height);
			frame = next;
			syncVisibility();
		},
		setVisible(next) {
			visible = next;
			writeCloudsVisible(storage, next);
			syncVisibility();
		},
		setTime(utcMs) {
			material.uniforms.sunDirection.value.set(...sunDirection(new Date(utcMs)));
		},
		dispose() {
			disposed = true;
			frame?.texture.dispose();
			frame = null;
			geometry.dispose();
			material.dispose();
		},
	};
}
