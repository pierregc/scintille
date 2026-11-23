export const MAX_PIXEL_RATIO = 2;

export function cappedPixelRatio(devicePixelRatio: number, max = MAX_PIXEL_RATIO): number {
	if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
	return Math.min(devicePixelRatio, max);
}

/** Lowest share of the CSS size drawn when a large screen exceeds the pixel budget. */
const MIN_PIXEL_RATIO = 0.5;

/** Pixel ratio that also keeps the drawing buffer within `megapixels`, so large or dense screens cost no more than the budget. */
export function budgetPixelRatio(devicePixelRatio: number, max: number, cssWidth: number, cssHeight: number, megapixels: number): number {
	const capped = cappedPixelRatio(devicePixelRatio, max);
	const area = cssWidth * cssHeight;
	if (!(area > 0)) return capped;
	return Math.max(MIN_PIXEL_RATIO, Math.min(capped, Math.sqrt((megapixels * 1e6) / area)));
}

/** Camera distance at which a sphere of `radius` fits the viewport; `margin` > 1 leaves room around it. */
export function fitDistance(radius: number, verticalFovDeg: number, aspect: number, margin = 1.15): number {
	const halfV = (verticalFovDeg * Math.PI) / 360;
	const halfH = Math.atan(Math.tan(halfV) * aspect);
	return (radius * margin) / Math.sin(Math.min(halfV, halfH));
}
