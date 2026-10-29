/** Geometry of the storm search (ADR 0027): 2° tiles, distance to a storm path, rounding. */

export const EARTH_KM = 6371;
export const KM_PER_DEG = (Math.PI * EARTH_KM) / 180;
export const TILE_DEG = 2;
const ROWS = 180 / TILE_DEG;
const COLS = 360 / TILE_DEG;

/** Query points are rounded to 0.1°, about 11 km. */
export const roundCoord = (value: number) => Math.round(value * 10) / 10;

const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
const row = (lat: number) => Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / TILE_DEG)));
const col = (lon: number) => Math.floor((wrap(lon) + 180) / TILE_DEG) % COLS;

export const tileOf = (lat: number, lon: number) => row(lat) * COLS + col(lon);

/** Tiles of the box around a disc of `km` around a point, west to east across the date line. */
export function queryTiles(lat: number, lon: number, km: number): number[] {
	const dLat = km / KM_PER_DEG;
	const south = Math.max(-90, lat - dLat);
	const north = Math.min(90, lat + dLat);
	const widest = Math.max(Math.abs(south), Math.abs(north));
	const dLon = widest >= 89.9 ? 180 : km / (KM_PER_DEG * Math.cos((widest * Math.PI) / 180));
	const cols: number[] = [];
	if (dLon >= 180) {
		for (let c = 0; c < COLS; c++) cols.push(c);
	} else {
		const first = Math.floor((lon - dLon + 180) / TILE_DEG);
		const last = Math.floor((lon + dLon + 180) / TILE_DEG);
		for (let c = first; c <= last; c++) cols.push(((c % COLS) + COLS) % COLS);
	}
	const tiles = new Set<number>();
	for (let r = row(south); r <= row(north); r++) for (const c of cols) tiles.add(r * COLS + c);
	return [...tiles].sort((a, b) => a - b);
}

type Vec = [number, number, number];

const unit = (lat: number, lon: number): Vec => {
	const phi = (lat * Math.PI) / 180;
	const lam = (lon * Math.PI) / 180;
	return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
};
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const angle = (a: Vec, b: Vec) => Math.atan2(norm(cross(a, b)), dot(a, b));

/** Angle from `p` to the shorter great-circle arc from `a` to `b`. */
function arcAngle(p: Vec, a: Vec, b: Vec): number {
	const n = cross(a, b);
	const length = norm(n);
	const ends = Math.min(angle(p, a), angle(p, b));
	if (length < 1e-12) return ends;
	const unitN: Vec = [n[0] / length, n[1] / length, n[2] / length];
	const offset = dot(p, unitN);
	const foot: Vec = [p[0] - offset * unitN[0], p[1] - offset * unitN[1], p[2] - offset * unitN[2]];
	if (norm(foot) < 1e-12) return ends;
	const inside = dot(cross(a, foot), unitN) >= 0 && dot(cross(foot, b), unitN) >= 0;
	return inside ? Math.asin(Math.min(1, Math.abs(offset))) : ends;
}

/** Kilometres from a point to the arcs joining hourly centroids `[lat, lon]`, minus `radiusKm`, at least 0. */
export function pathDistanceKm(lat: number, lon: number, path: readonly (readonly [number, number])[], radiusKm = 0): number {
	if (!path.length) return Infinity;
	const p = unit(lat, lon);
	const points = path.map(([pLat, pLon]) => unit(pLat, pLon));
	let best = angle(p, points[0]);
	for (let i = 1; i < points.length; i++) best = Math.min(best, arcAngle(p, points[i - 1], points[i]));
	return Math.max(0, best * EARTH_KM - radiusKm);
}

/** Distance shown to visitors: 10 km steps. */
export const shownKm = (km: number) => Math.round(km / 10) * 10;
