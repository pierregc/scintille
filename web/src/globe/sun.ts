export interface SubsolarPoint {
	/** Latitude in degrees, north positive. */
	lat: number;
	/** Longitude in degrees in [-180, 180), east positive. */
	lon: number;
}

export type Vec3 = [x: number, y: number, z: number];

const DEG = Math.PI / 180;

const sinDeg = (d: number) => Math.sin(d * DEG);
const cosDeg = (d: number) => Math.cos(d * DEG);

/** Subsolar point at a UTC instant, using the NOAA solar calculator equations. */
export function subsolarPoint(date: Date): SubsolarPoint {
	const julianDay = date.getTime() / 86_400_000 + 2_440_587.5;
	const t = (julianDay - 2_451_545) / 36_525;

	const meanLong = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
	const meanAnom = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
	const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
	const center =
		sinDeg(meanAnom) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
		sinDeg(2 * meanAnom) * (0.019993 - 0.000101 * t) +
		sinDeg(3 * meanAnom) * 0.000289;
	const omega = 125.04 - 1934.136 * t;
	const appLong = meanLong + center - 0.00569 - 0.00478 * sinDeg(omega);
	const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
	const obliq = meanObliq + 0.00256 * cosDeg(omega);

	const lat = Math.asin(sinDeg(obliq) * sinDeg(appLong)) / DEG;

	const y = Math.tan((obliq / 2) * DEG) ** 2;
	const eqTimeMinutes =
		(4 / DEG) *
		(y * sinDeg(2 * meanLong) -
			2 * eccent * sinDeg(meanAnom) +
			4 * eccent * y * sinDeg(meanAnom) * cosDeg(2 * meanLong) -
			0.5 * y * y * sinDeg(4 * meanLong) -
			1.25 * eccent * eccent * sinDeg(2 * meanAnom));

	const utcMinutes = (((date.getTime() / 60_000) % 1440) + 1440) % 1440;
	const lon = -(utcMinutes - 720 + eqTimeMinutes) / 4;

	return { lat, lon: wrapLongitude(lon) };
}

/**
 * Globe convention (Y-up, matches THREE.SphereGeometry UVs):
 * x = cos(lat)·cos(lon), y = sin(lat), z = −cos(lat)·sin(lon).
 */
export function latLonToVector(lat: number, lon: number): Vec3 {
	return [cosDeg(lat) * cosDeg(lon), sinDeg(lat), -cosDeg(lat) * sinDeg(lon)];
}

/** Unit vector from the globe center toward the sun at a UTC instant. */
export function sunDirection(date: Date): Vec3 {
	const { lat, lon } = subsolarPoint(date);
	return latLonToVector(lat, lon);
}

function wrapLongitude(lon: number): number {
	return ((((lon + 180) % 360) + 360) % 360) - 180;
}
