import type { CoverageFeature, CoverageMap } from '../../contract/types';
import { CONTRACT_MAJOR } from '../live/decode';

type Ring = number[][];
type Polygon = Ring[];

/** Checks the parts of `live/coverage.geojson` the overlay relies on. */
export function parseCoverage(json: unknown): CoverageMap {
	const map = json as CoverageMap;
	const major = Number(String(map?.schema_version).split('.')[0]);
	if (map?.type !== 'FeatureCollection' || !Array.isArray(map.features) || major !== CONTRACT_MAJOR) {
		throw new Error(`coverage map version ${String(map?.schema_version)}, expected major ${CONTRACT_MAJOR}`);
	}
	return map;
}

function gaps(map: CoverageMap): CoverageFeature[] {
	return map.features.filter((f) => f.properties.kind === 'no-coverage');
}

/** Even-odd test in the lon/lat plane, as the polygons are drawn. */
export function insideRing(lon: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [x1, y1] = ring[j];
		const [x2, y2] = ring[i];
		if (y1 > lat !== y2 > lat && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
	}
	return inside;
}

function insidePolygon(lon: number, lat: number, [outer, ...holes]: Polygon): boolean {
	return insideRing(lon, lat, outer) && !holes.some((hole) => insideRing(lon, lat, hole));
}

/** Whether no satellite sees the point. */
export function gapAt(map: CoverageMap, lat: number, lon: number): boolean {
	return gaps(map).some((f) => f.geometry.coordinates.some((polygon) => insidePolygon(lon, lat, polygon)));
}

/** The part of a 2D context the mask drawing uses. */
export type MaskContext = Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fill' | 'clearRect' | 'fillStyle'>;

/** Paints the no coverage area white on an equirectangular canvas (west edge at 180° W, top row at 90° N). */
export function drawGaps(ctx: MaskContext, map: CoverageMap, width: number, height: number): void {
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = '#fff';
	for (const feature of gaps(map)) {
		for (const polygon of feature.geometry.coordinates) {
			ctx.beginPath();
			for (const ring of polygon) {
				ring.forEach(([lon, lat], i) => {
					const x = ((lon + 180) / 360) * width;
					const y = ((90 - lat) / 180) * height;
					if (i === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				});
				ctx.closePath();
			}
			ctx.fill('evenodd');
		}
	}
}
