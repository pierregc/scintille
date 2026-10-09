export const MAX_PIXEL_RATIO = 2;

export function cappedPixelRatio(devicePixelRatio: number, max = MAX_PIXEL_RATIO): number {
	if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
	return Math.min(devicePixelRatio, max);
}

/** Camera distance at which a sphere of `radius` fits the viewport; `margin` > 1 leaves room around it. */
export function fitDistance(radius: number, verticalFovDeg: number, aspect: number, margin = 1.15): number {
	const halfV = (verticalFovDeg * Math.PI) / 360;
	const halfH = Math.atan(Math.tan(halfV) * aspect);
	return (radius * margin) / Math.sin(Math.min(halfV, halfH));
}
