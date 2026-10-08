// Builds globe textures (day, night, ocean mask) for every quality tier.
// Usage: pnpm -C web textures
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'out');
const WORK_DIR = join(ROOT, '.cache', 'work');
const BASISU = process.env.BASISU ?? 'basisu';

const NASA_EO = 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images';
const NATURAL_EARTH =
	'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';

/** Pinned sources: a cached file is reused only if its size and SHA-256 match. */
const SOURCES = {
	day: {
		url: `${NASA_EO}/bmng/bmng-topography-bathymetry/august/world.topo.bathy.200408.3x21600x10800.jpg`,
		bytes: 27216225,
		sha256: '05d984f723776f3d44fc473cc3d9eb67a48c425e82a56d7133e3761b2e231e86',
	},
	night: {
		url: `${NASA_EO}/imagerecords/144000/144898/BlackMarble_2016_3km.jpg`,
		bytes: 8106233,
		sha256: '230aac448ae68c358be433dd518888cccb3a85ccf66f7b44326441c324ad6725',
	},
	ocean: {
		url: `${NATURAL_EARTH}/ne_10m_ocean.geojson`,
		bytes: 10151895,
		sha256: 'f9696a1337c746a0f6c8c13bc60d0f230d2ef8d105198d5657726c8f8e763fc2',
	},
	lakes: {
		url: `${NATURAL_EARTH}/ne_10m_lakes.geojson`,
		bytes: 5043554,
		sha256: '2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9',
	},
};

const TIERS = [
	{ name: '8k', width: 8192 },
	{ name: '4k', width: 4096 },
	{ name: '2k', width: 2048 },
];

/** basisu ETC1S settings per texture; the mask is data, not color. */
const TEXTURES = {
	day: { quality: 90, linear: false, webp: { quality: 85 } },
	night: { quality: 90, linear: false, webp: { quality: 85 } },
	mask: { quality: 60, linear: true, webp: { lossless: true } },
};

async function sha256File(path) {
	return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fetchSource(name) {
	const src = SOURCES[name];
	const file = join(CACHE_DIR, src.url.split('/').pop());
	const isValid = async () =>
		(await stat(file)).size === src.bytes && (await sha256File(file)) === src.sha256;

	try {
		if (await isValid()) return file;
		console.warn(`cache: ${name} does not match the pinned checksum, downloading again`);
	} catch {
		// Not cached yet.
	}

	console.log(`download: ${src.url}`);
	const res = await fetch(src.url);
	if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${src.url}`);
	const part = `${file}.part`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(part));

	const bytes = (await stat(part)).size;
	const sha256 = await sha256File(part);
	if (bytes !== src.bytes || sha256 !== src.sha256) {
		await rm(part);
		throw new Error(
			`checksum mismatch for ${name}: got ${bytes} bytes, sha256 ${sha256}; ` +
				`expected ${src.bytes} bytes, sha256 ${src.sha256}`,
		);
	}
	await rename(part, file);
	return file;
}

function assertBasisu() {
	const probe = spawnSync(BASISU, ['-version'], { encoding: 'utf8' });
	if (probe.error || probe.status !== 0) {
		throw new Error(
			`KTX2 encoder "${BASISU}" not found. Install Basis Universal ` +
				'(macOS: brew install basis_universal) or set BASISU to the binary path.',
		);
	}
}

/** Equirectangular SVG path for GeoJSON polygons. */
function geojsonToPath(geojson, width, height) {
	const parts = [];
	for (const feature of geojson.features) {
		const { type, coordinates } = feature.geometry;
		const polygons = type === 'Polygon' ? [coordinates] : coordinates;
		for (const rings of polygons) {
			for (const ring of rings) {
				const points = ring.map(([lon, lat]) => {
					const x = ((lon + 180) / 360) * width;
					const y = ((90 - lat) / 180) * height;
					return `${x.toFixed(2)} ${y.toFixed(2)}`;
				});
				parts.push(`M${points.join('L')}Z`);
			}
		}
	}
	return parts.join('');
}

/** Water = white, land = black. */
async function buildMaskPng(oceanFile, lakesFile, width, height, out) {
	const ocean = JSON.parse(await readFile(oceanFile, 'utf8'));
	const lakes = JSON.parse(await readFile(lakesFile, 'utf8'));
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
		`<rect width="100%" height="100%" fill="#000"/>` +
		`<path fill="#fff" fill-rule="evenodd" d="${geojsonToPath(ocean, width, height)}"/>` +
		`<path fill="#fff" fill-rule="evenodd" d="${geojsonToPath(lakes, width, height)}"/>` +
		`</svg>`;
	await sharp(Buffer.from(svg), { limitInputPixels: false, unlimited: true })
		.toColourspace('b-w')
		.png()
		.toFile(out);
}

async function resizePng(input, width, height, out) {
	await sharp(input, { limitInputPixels: false })
		.resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
		.removeAlpha()
		.png({ compressionLevel: 1 })
		.toFile(out);
}

function encodeKtx2(png, out, { quality, linear }) {
	// -y_flip: Three.js cannot flip compressed textures, so store them bottom-up.
	const args = [
		'-ktx2',
		'-etc1s',
		'-mipmap',
		'-y_flip',
		'-quality',
		String(quality),
		'-effort',
		'5',
		linear ? '-linear' : '-srgb',
		'-quiet',
		'-no_stats',
		'-file',
		png,
		'-output_file',
		out,
	];
	const run = spawnSync(BASISU, args, { stdio: ['ignore', 'ignore', 'inherit'] });
	if (run.status !== 0) throw new Error(`basisu failed on ${png}`);
}

async function encodeWebp(png, out, options) {
	await sharp(png, { limitInputPixels: false }).webp({ effort: 6, ...options }).toFile(out);
}

async function main() {
	assertBasisu();
	await mkdir(WORK_DIR, { recursive: true });

	const files = {};
	for (const name of Object.keys(SOURCES)) files[name] = await fetchSource(name);

	await rm(OUT_DIR, { recursive: true, force: true });
	const manifest = { generated: new Date().toISOString(), tiers: {} };

	for (const tier of TIERS) {
		const width = tier.width;
		const height = width / 2;
		const dir = join(OUT_DIR, tier.name);
		await mkdir(dir, { recursive: true });
		console.log(`tier ${tier.name}: ${width}x${height}`);

		const pngs = {
			day: join(WORK_DIR, `day-${tier.name}.png`),
			night: join(WORK_DIR, `night-${tier.name}.png`),
			mask: join(WORK_DIR, `mask-${tier.name}.png`),
		};
		await resizePng(files.day, width, height, pngs.day);
		await resizePng(files.night, width, height, pngs.night);
		await buildMaskPng(files.ocean, files.lakes, width, height, pngs.mask);

		const entry = { width, height, files: {}, ktx2Bytes: 0, webpBytes: 0 };
		for (const [name, settings] of Object.entries(TEXTURES)) {
			const ktx2 = join(dir, `${name}.ktx2`);
			const webp = join(dir, `${name}.webp`);
			encodeKtx2(pngs[name], ktx2, settings);
			await encodeWebp(pngs[name], webp, settings.webp);
			const ktx2Bytes = (await stat(ktx2)).size;
			const webpBytes = (await stat(webp)).size;
			entry.files[name] = { ktx2: ktx2Bytes, webp: webpBytes };
			entry.ktx2Bytes += ktx2Bytes;
			entry.webpBytes += webpBytes;
		}
		manifest.tiers[tier.name] = entry;
	}

	await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	await rm(WORK_DIR, { recursive: true, force: true });

	const mb = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;
	console.table(
		Object.fromEntries(
			Object.entries(manifest.tiers).map(([name, t]) => [
				name,
				{ ktx2: mb(t.ktx2Bytes), webp: mb(t.webpBytes) },
			]),
		),
	);
	console.log(`output: ${OUT_DIR}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
