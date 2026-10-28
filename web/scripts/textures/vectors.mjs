// Builds the vector overlay prototype (#125): Natural Earth 10m coastlines, borders, lakes and main cities.
// Output: out/vectors/lines.bin, little endian: uint32 count per class, then int16 lon, lat pairs per segment end.
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'out', 'vectors');

/** Classes in drawing order; cities are points (one pair each). */
const CLASSES = [
	['coast', 'ne_10m_coastline.geojson'],
	['border', 'ne_10m_admin_0_boundary_lines_land.geojson'],
	['lake', 'ne_10m_lakes.geojson'],
	['city', 'ne_10m_populated_places_simple.geojson'],
];
/** Cities kept: Natural Earth scale rank at most this (lower is more important). */
const CITY_RANK = 3;

const q = (lon, lat) => [Math.round((lon / 180) * 32767), Math.round((lat / 90) * 32767)];

function lines(geometry) {
	const { type, coordinates } = geometry;
	if (type === 'LineString') return [coordinates];
	if (type === 'MultiLineString' || type === 'Polygon') return coordinates;
	if (type === 'MultiPolygon') return coordinates.flat();
	return [];
}

const counts = [];
const values = [];
for (const [name, file] of CLASSES) {
	const { features } = JSON.parse(await readFile(join(CACHE_DIR, file), 'utf8'));
	let n = 0;
	for (const feature of features) {
		if (name === 'city') {
			if (feature.properties.scalerank > CITY_RANK) continue;
			values.push(...q(...feature.geometry.coordinates));
			n++;
			continue;
		}
		for (const line of lines(feature.geometry)) {
			for (let i = 1; i < line.length; i++) {
				values.push(...q(...line[i - 1]), ...q(...line[i]));
				n++;
			}
		}
	}
	counts.push(n);
	console.log(`${name}: ${n}`);
}
const header = new Uint32Array(counts);
const body = new Int16Array(values);
const bin = Buffer.concat([Buffer.from(header.buffer), Buffer.from(body.buffer)]);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'lines.bin'), bin);
console.log(`lines.bin: ${(bin.length / 1e6).toFixed(2)} MB, gzip ${(gzipSync(bin, { level: 9 }).length / 1e6).toFixed(2)} MB`);
