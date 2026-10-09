import type { FlyToOptions } from './flight';

/** Parses `?fly=lat,lon[,altitudeKm[,tilt]];…` into a chain of flights. */
export function parseDevFlights(search: string): FlyToOptions[] {
	const value = new URLSearchParams(search).get('fly');
	if (!value) return [];
	return value.split(';').flatMap((stop) => {
		const [lat, lon, altitude, tilt] = stop.split(',').map(Number);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
		return [{ lat, lon, altitude: Number.isFinite(altitude) ? altitude : undefined, tilt: Number.isFinite(tilt) ? tilt : 0 }];
	});
}

/** Dev only: flies the chain from `?fly=`, starting after `delayMs`. */
export async function runDevFlights(
	flyTo: (options: FlyToOptions) => Promise<boolean>,
	search: string,
	delayMs = 3000,
): Promise<void> {
	const flights = parseDevFlights(search);
	if (flights.length === 0) return;
	await new Promise((resolve) => setTimeout(resolve, delayMs));
	for (const flight of flights) {
		if (!(await flyTo(flight))) return;
	}
}
