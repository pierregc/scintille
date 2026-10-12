import type { CoverageFeature, CoverageMap, LiveManifest, Source } from '../../contract/types';
import { CONTRACT_MAJOR } from '../live/decode';

type Ring = number[][];
type Polygon = Ring[];

/** Where flashes cannot show right now, and why. */
export type Gap = { kind: 'no-coverage' } | { kind: 'down'; sources: Source[] };

/** Checks the parts of `live/coverage.geojson` the overlay relies on. */
export function parseCoverage(json: unknown): CoverageMap {
	const map = json as CoverageMap;
	const major = Number(String(map?.schema_version).split('.')[0]);
	if (map?.type !== 'FeatureCollection' || !Array.isArray(map.features) || major !== CONTRACT_MAJOR) {
		throw new Error(`coverage map version ${String(map?.schema_version)}, expected major ${CONTRACT_MAJOR}`);
	}
	return map;
}

/** Sources the manifest reports `offline`, i.e. down. */
export function downSources(manifest: Pick<LiveManifest, 'sources'> | null): Set<Source> {
	return new Set((manifest?.sources ?? []).filter((s) => s.state === 'offline').map((s) => s.source));
}

function footprints(map: CoverageMap, down: ReadonlySet<Source>, isDown: boolean): CoverageFeature[] {
	return map.features.filter(
		(f) => f.properties.kind === 'footprint' && f.properties.source !== null && down.has(f.properties.source) === isDown,
	);
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

function inside(lon: number, lat: number, feature: CoverageFeature): boolean {
	return feature.geometry.coordinates.some((polygon) => insidePolygon(lon, lat, polygon));
}

/** The gap at a point, or null where a live source sees it. */
export function gapAt(map: CoverageMap, down: ReadonlySet<Source>, lat: number, lon: number): Gap | null {
	if (footprints(map, down, false).some((f) => inside(lon, lat, f))) return null;
	const sources = footprints(map, down, true)
		.filter((f) => inside(lon, lat, f))
		.map((f) => f.properties.source as Source);
	if (sources.length > 0) return { kind: 'down', sources };
	return map.features.some((f) => f.properties.kind === 'no-coverage' && inside(lon, lat, f)) ? { kind: 'no-coverage' } : null;
}

/** The part of a 2D context the mask drawing uses. */
export type MaskContext = Pick<
	CanvasRenderingContext2D,
	'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'fill' | 'clearRect' | 'fillStyle' | 'globalCompositeOperation'
>;

function tracePolygon(ctx: MaskContext, polygon: Polygon, width: number, height: number): void {
	for (const ring of polygon) {
		ring.forEach(([lon, lat], i) => {
			const x = ((lon + 180) / 360) * width;
			const y = ((90 - lat) / 180) * height;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.closePath();
	}
}

function fillFeatures(ctx: MaskContext, features: CoverageFeature[], width: number, height: number): void {
	for (const feature of features) {
		for (const polygon of feature.geometry.coordinates) {
			ctx.beginPath();
			tracePolygon(ctx, polygon, width, height);
			ctx.fill('evenodd');
		}
	}
}

/**
 * Paints the gaps white on an equirectangular canvas (west edge at 180° W, top row at 90° N): the no
 * coverage area and the footprints of down sources, minus what live footprints still see.
 */
export function drawGaps(ctx: MaskContext, map: CoverageMap, down: ReadonlySet<Source>, width: number, height: number): void {
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = '#fff';
	ctx.globalCompositeOperation = 'source-over';
	const gaps = map.features.filter((f) => f.properties.kind === 'no-coverage');
	fillFeatures(ctx, [...gaps, ...footprints(map, down, true)], width, height);
	ctx.globalCompositeOperation = 'destination-out';
	fillFeatures(ctx, footprints(map, down, false), width, height);
	ctx.globalCompositeOperation = 'source-over';
}
