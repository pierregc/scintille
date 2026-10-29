/** Nearby query rules (ADR 0027): bounded inputs, window, distance and deterministic ranking. */
import { pathDistanceKm, roundCoord, shownKm } from './geo';

export const NEARBY_LIMITS = {
	hours: { min: 1, max: 168, default: 72 },
	km: { min: 10, max: 3000, default: 200 },
	limit: { min: 1, max: 8, default: 4 },
} as const;
/** Two missed hourly catalog runs. */
export const STALE_AFTER_MS = 3 * 3_600_000;

export interface NearbyQuery {
	lat: number;
	lon: number;
	hours: number;
	km: number;
	limit: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function integer(params: URLSearchParams, name: keyof typeof NEARBY_LIMITS, errors: string[]): number {
	const { min, max, default: fallback } = NEARBY_LIMITS[name];
	const raw = params.get(name);
	if (raw === null || raw === '') return fallback;
	const value = Number(raw);
	if (!/^\d+$/.test(raw) || value < min || value > max) errors.push(`${name} must be an integer from ${min} to ${max}`);
	return value;
}

function coordinate(params: URLSearchParams, name: 'lat' | 'lon', bound: number, errors: string[]): number {
	const raw = params.get(name);
	const value = Number(raw);
	if (raw === null || !/^-?\d+(\.\d+)?$/.test(raw) || Math.abs(value) > bound) {
		errors.push(`${name} must be a number from -${bound} to ${bound}`);
		return NaN;
	}
	return roundCoord(value);
}

/** Out of range values are refused, never clamped. */
export function parseNearbyQuery(params: URLSearchParams): Parsed<NearbyQuery> {
	const errors: string[] = [];
	const value = {
		lat: coordinate(params, 'lat', 90, errors),
		lon: coordinate(params, 'lon', 180, errors),
		hours: integer(params, 'hours', errors),
		km: integer(params, 'km', errors),
		limit: integer(params, 'limit', errors),
	};
	return errors.length ? { ok: false, errors } : { ok: true, value };
}

/** Canonical query string: the cache key of a response. */
export const nearbyKey = (q: NearbyQuery) => `lat=${q.lat}&lon=${q.lon}&hours=${q.hours}&km=${q.km}&limit=${q.limit}`;

export interface Candidate {
	slug: string;
	t_start: number;
	t_end: number;
	score: number;
	path: [number, number][];
	radius_km: number;
}

export interface Match<C extends Candidate> {
	candidate: C;
	distance_km: number;
	rank: number;
}

/** Doubling the ADR 0009 score is worth one day of recency or 100 km. */
export const rankOf = (score: number, ageHours: number, km: number) => Math.log2(Math.max(score, 1)) - ageHours / 24 - km / 100;

/** Storms whose interval meets the window and whose path comes within `km`, best first. */
export function rankNearby<C extends Candidate>(candidates: readonly C[], q: NearbyQuery, nowSeconds: number): Match<C>[] {
	const from = nowSeconds - q.hours * 3600;
	const matches: Match<C>[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate.slug) || candidate.t_end < from || candidate.t_start > nowSeconds) continue;
		seen.add(candidate.slug);
		const distance = pathDistanceKm(q.lat, q.lon, candidate.path, candidate.radius_km);
		if (distance > q.km) continue;
		const age = Math.max(0, nowSeconds - candidate.t_end) / 3600;
		matches.push({ candidate, distance_km: shownKm(distance), rank: rankOf(candidate.score, age, distance) });
	}
	return matches.sort((a, b) => b.rank - a.rank || a.distance_km - b.distance_km ||
		b.candidate.t_end - a.candidate.t_end || (a.candidate.slug < b.candidate.slug ? -1 : 1));
}
