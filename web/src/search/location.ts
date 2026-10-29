/** Approximate visitor location from Cloudflare's IP geolocation (ADR 0027). */
import { roundCoord } from './geo';

export interface IpGeo {
	city?: string | null;
	region?: string | null;
	country?: string | null;
	latitude?: string | null;
	longitude?: string | null;
}

export type ApproximateLocation =
	| { status: 'approximate'; source: 'ip'; lat: number; lon: number; city: string; region: string | null; country_code: string | null }
	| { status: 'unavailable'; source: 'ip' };

export const PRIVATE_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };

/** A city and its coordinates, rounded to 0.1°; a country alone is not a location. */
export function approximateLocation(geo: IpGeo | null | undefined): ApproximateLocation {
	const lat = Number(geo?.latitude);
	const lon = Number(geo?.longitude);
	const city = geo?.city?.trim();
	if (!city || !geo?.latitude || !geo.longitude || !Number.isFinite(lat) || !Number.isFinite(lon) ||
		Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return { status: 'unavailable', source: 'ip' };
	const country = geo.country && /^[A-Z]{2}$/.test(geo.country) && geo.country !== 'XX' && geo.country !== 'T1' ? geo.country : null;
	return { status: 'approximate', source: 'ip', lat: roundCoord(lat), lon: roundCoord(lon), city, region: geo.region?.trim() || null, country_code: country };
}
