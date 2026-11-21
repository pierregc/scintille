import type { IUniform, Object3D, Texture, WebGLRenderer } from 'three';

/** Level of a wind field (ADR 0039). */
export type WindLevel = '10m' | '250hPa';

/** What the viewer picked: high jet stream ribbons or the surface veil. */
export type WindLook = 'jet' | 'surface';

export const WIND_LOOK_LEVEL: Readonly<Record<WindLook, WindLevel>> = { jet: '250hPa', surface: '10m' };

/** One hourly field on the 0.5° grid: u in red, v in green, (byte - 128) / 127 * scaleMs metres per second. */
export interface WindField {
	/** Valid time of the forecast, UTC ms. */
	time: number;
	level: WindLevel;
	texture: Texture;
	scaleMs: number;
}

export interface WindLayerOptions {
	radius: number;
	/** The cloud layer's opacity uniforms and defines, read with `cloudOpacityGlsl`. */
	cloudOpacity: { uniforms: Record<string, IUniform>; defines: Record<string, string> };
}

export interface WindFrameParams {
	renderer: WebGLRenderer;
	/** Kilometres per screen pixel at the globe, from the camera height. */
	kmPerPx: number;
	/** Wall clock (the render clock when rendering a video), ms: drives the fibre drift. */
	wallMs: number;
	/** Unit vector toward the sun, world space. */
	sun: readonly [number, number, number];
	/** Reduced motion: no drift. */
	steady: boolean;
	/** Close storm view: the fibres fade out. */
	stormView: boolean;
}

export interface WindLayer {
	readonly object: Object3D;
	/** null hides the layer. */
	setLook(look: WindLook | null): void;
	/** Fields on each side of the scene time and the share of `b`; a null `a` hides the layer. The caller owns the textures. */
	setFields(a: WindField | null, b: WindField | null, mix: number): void;
	/** Once per rendered frame, before the scene renders. */
	update(params: WindFrameParams): void;
	dispose(): void;
}
