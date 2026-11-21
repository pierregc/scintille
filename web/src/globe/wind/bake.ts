import { Matrix4, Vector3, Vector4 } from 'three';

/** The fibres are baked as seen from a camera, a little wider than the screen, and reprojected until the view drifts. */
export const BAKE = {
	/** Extra field of view on each side, as a share: small pans reuse the bake. */
	margin: 0.15,
	/** Largest bake, texels. */
	maxTexels: 3.5e6,
	/** Texels baked per frame: a bake spreads over a few frames. */
	bandTexels: 7e5,
	/** Crossfade from one bake to the next, ms; also the shortest time between two bakes. */
	fadeMs: 300,
	/** Scale drift that calls for a new bake: natural log of the kilometres per pixel ratio. */
	scaleDrift: 0.15,
	/** Shortest bake texel, as a share of a screen pixel, at a visible point. */
	minDensity: 0.7,
	/** Facing under which a point is too dim to matter. */
	minFacing: 0.15,
} as const;

/** Rays per side checked against the bake. */
const GRID = 9;

export interface BakeView {
	/** World to the bake's clip space. */
	viewProjection: Matrix4;
	eye: Vector3;
	kmPerPx: number;
}

export interface ScreenView {
	inverseViewProjection: Matrix4;
	eye: Vector3;
	kmPerPx: number;
}

/** Bake size for a CSS viewport and a share of its resolution, and the share kept after the caps. */
export function bakeSize(cssWidth: number, cssHeight: number, scale: number, maxSize: number): { width: number; height: number; scale: number } {
	const width = cssWidth * (1 + BAKE.margin) * scale;
	const height = cssHeight * (1 + BAKE.margin) * scale;
	const shrink = Math.min(1, Math.sqrt(BAKE.maxTexels / Math.max(1, width * height)), maxSize / width, maxSize / height);
	return { width: Math.max(1, Math.round(width * shrink)), height: Math.max(1, Math.round(height * shrink)), scale: scale * shrink };
}

/** World to bake clip space: the camera's projection widened by the margin. */
export function bakeViewProjection(projection: Matrix4, worldInverse: Matrix4, target = new Matrix4()): Matrix4 {
	const k = 1 / (1 + BAKE.margin);
	return target.makeScale(k, k, 1).multiply(projection).multiply(worldInverse);
}

const far = new Vector3();
const ray = new Vector3();
const hit = new Vector3();
const clip = new Vector4();

function sphereHit(eye: Vector3, direction: Vector3, radius: number, out: Vector3): Vector3 | null {
	const b = eye.dot(direction);
	const disc = b * b - eye.lengthSq() + radius * radius;
	if (disc <= 0) return null;
	const t = -b - Math.sqrt(disc);
	return t > 0 ? out.copy(direction).multiplyScalar(t).add(eye) : null;
}

/** Whether a bake still serves a view: same scale, and every visible point inside it, seen at a fair density. */
export function bakeServes(bake: BakeView, view: ScreenView, radius: number): boolean {
	if (Math.abs(Math.log(view.kmPerPx / bake.kmPerPx)) > BAKE.scaleDrift) return false;
	for (let j = 0; j < GRID; j++) {
		for (let i = 0; i < GRID; i++) {
			far.set((2 * i) / (GRID - 1) - 1, (2 * j) / (GRID - 1) - 1, 1).applyMatrix4(view.inverseViewProjection);
			if (!sphereHit(view.eye, ray.subVectors(far, view.eye).normalize(), radius, hit)) continue;
			const distance = hit.distanceTo(view.eye);
			const facing = (hit.dot(view.eye) - radius * radius) / (radius * distance);
			if (facing < BAKE.minFacing) continue;
			const bakeDistance = hit.distanceTo(bake.eye);
			const bakeFacing = (hit.dot(bake.eye) - radius * radius) / (radius * bakeDistance);
			if (bakeFacing <= 0) return false;
			clip.set(hit.x, hit.y, hit.z, 1).applyMatrix4(bake.viewProjection);
			if (clip.w <= 0 || Math.abs(clip.x) > clip.w || Math.abs(clip.y) > clip.w) return false;
			if (Math.sqrt(bakeFacing / facing) * (distance / bakeDistance) < BAKE.minDensity) return false;
		}
	}
	return true;
}
