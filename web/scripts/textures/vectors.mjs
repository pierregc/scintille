// Builds the vector overlay prototype (#125): Natural Earth 10m coastlines, borders, lakes and main cities.
// Output: out/vectors/lines.bin, little endian: uint32 count per class, then int16 lon, lat pairs per segment end.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'out', 'vectors');

const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';

/** Classes in drawing order with their pinned source; cities are points (one pair each). */
const CLASSES = [
	['coast', 'ne_10m_coastline.geojson', '6f75ae0e0de157b14946e2255eb1f5486d9a13819032e26d4610852d296788f6'],
	['border', 'ne_10m_admin_0_boundary_lines_land.geojson', '74d9c16229c095fde65943a9919e337682f044bcebccb120764f38edf3b70f4a'],
	['lake', 'ne_10m_lakes.geojson', '2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9'],
	['city', 'ne_10m_populated_places_simple.geojson', 'fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f'],
];

async function source(file, sha256) {
	const path = join(CACHE_DIR, file);
	let data = await readFile(path).catch(() => null);
	if (!data || createHash('sha256').update(data).digest('hex') !== sha256) {
		console.log(`download: ${file}`);
		data = Buffer.from(await (await fetch(`${NATURAL_EARTH}/${file}`)).arrayBuffer());
		if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error(`checksum mismatch for ${file}`);
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(path, data);
	}
	return JSON.parse(data.toString('utf8'));
}

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
for (const [name, file, sha256] of CLASSES) {
	const { features } = await source(file, sha256);
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
