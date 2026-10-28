// Builds the surface tile pyramid of ADR 0022 from the 500 m Blue Marble and Black Marble releases.
// Usage: node scripts/textures/tiles.mjs [--sources B2,C1] [--out <dir>]
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { BORDER, COLUMNS, LAYERS, LEVELS, MAX_LEVEL, PATH, ROWS, SOURCE_PX, SURFACE_VERSION, TILE, columns, rows, tilePath } from './surface.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');

const NASA_EO = 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images';
const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';

const SOURCES = {
	day: {
		url: (t) => `${NASA_EO}/bmng/bmng-topography/august/world.topo.200408.3x21600x21600.${t}.jpg`,
		files: {
			A1: [47352572, '284bee5bac0f28c758fafc999aeb564328089ae987aa8cea35521662d5c51cf6'],
			A2: [20896108, '45cc40b48b4c2f3187855d1bb77e559c0cef1ec405620e3992fff9618897eb2d'],
			B1: [44638095, 'e3dd8a6c175cc27171d78822d2e7ea989efac04b210bf85e8128d3c1ea2f514c'],
			B2: [41911207, 'e62a55b5dfcd91acc6556a44c7673d0299007284d10d2ec21e1f3a29e1a0bda1'],
			C1: [83876914, '160f8dc644d386c067b66c8735c5b8df4f4bb7e05894c4ec8765ed7ddc01a99d'],
			C2: [33336903, '9f4816f549c3db0c476753f0538edff97e9fff22a9361c2923ea2cc36f1a6b9d'],
			D1: [61831146, '351fec971ecb324a836b0d33caab452fccec880912dc64049e70cab018a74dd8'],
			D2: [37963310, '28c5a0286d8dbe729af80abbafdacf2f5860cc429ad33fbedf520165699726d8'],
		},
	},
	night: {
		url: (t) => `${NASA_EO}/imagerecords/144000/144898/BlackMarble_2016_${t}.jpg`,
		files: {
			A1: [30825698, 'f9e9a0fc1c6227bfb174639e5ff70d4f081810b4c72834a1ccdb9687150436f2'],
			A2: [7830664, 'ed5c047b606caca73a829c912c8388db07ecfa6670baf1358fd9e538ef773428'],
			B1: [29472401, 'd0ef6a0b15032d277235d59c336e82c6fbe9693cfa26aaa72fec92962574d11e'],
			B2: [21337236, 'f56f36e2b76993b34dcf83163d8c8a23255251031597337833c9eb2400c5aa9b'],
			C1: [59097456, '446fcc72755ebc3625f96d39f2bcb247016038b74c90c655a65991e6de71b3b5'],
			C2: [13553256, 'f52cb69c0eadb2efa0868472cca59ac5461df5c4a0ce27846bff1e60cbafbe44'],
			D1: [39122860, '449fdd6b2f6eec087f56b5a0dcee5ab3213ea0ade75ec746f38cea76f3acd442'],
			D2: [14400257, '295a0b58aefc581ee3bcc8e513ce4e1a475057ab3de9dc94ccf5c0fe39be9972'],
		},
	},
	ocean: { url: `${NATURAL_EARTH}/ne_10m_ocean.geojson`, bytes: 10151895, sha256: 'f9696a1337c746a0f6c8c13bc60d0f230d2ef8d105198d5657726c8f8e763fc2' },
	lakes: { url: `${NATURAL_EARTH}/ne_10m_lakes.geojson`, bytes: 5043554, sha256: '2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9' },
};

const ATTRIBUTION = {
	day: 'NASA Earth Observatory, Blue Marble Next Generation, August 2004 (public domain)',
	night: 'NASA Earth Observatory, Black Marble 2016, Suomi NPP VIIRS (public domain)',
	water: 'Natural Earth 10m ocean and lakes v5.1.2 (public domain)',
};

/** Source pixels added around each source tile: the Lanczos support of the coarsest level plus its border texel. */
const PAD = 32;

const { values } = parseArgs({
	options: {
		sources: { type: 'string' },
		out: { type: 'string', default: join(ROOT, 'out', 'surface') },
		concurrency: { type: 'string', default: '12' },
	},
});
const OUT_DIR = values.out;
const ONLY = values.sources ? new Set(values.sources.split(',')) : null;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function fetchPinned(url, bytes, hash, dir) {
	const file = join(dir, url.split('/').pop());
	try {
		if ((await stat(file)).size === bytes && sha256(await readFile(file)) === hash) return file;
	} catch {
		// Not cached yet.
	}
	console.log(`download: ${url}`);
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`download failed (${res.status}): ${url}`);
	const part = `${file}.part`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
	const got = [(await stat(part)).size, sha256(await readFile(part))];
	if (got[0] !== bytes || got[1] !== hash) {
		await rm(part);
		throw new Error(`checksum mismatch for ${url}: got ${got.join(' ')}`);
	}
	await rename(part, file);
	return file;
}

async function decode(file) {
	const { data, info } = await sharp(file, { limitInputPixels: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	if (info.width !== SOURCE_PX || info.height !== SOURCE_PX || info.channels !== 3) throw new Error(`${file}: ${info.width}x${info.height}x${info.channels}`);
	return data;
}

/** Strips of PAD pixels along each edge of a decoded source tile. */
function edges(data, channels) {
	const row = SOURCE_PX * channels;
	const strip = (x0, y0, w, h) => {
		const out = Buffer.alloc(w * h * channels);
		for (let y = 0; y < h; y++) data.copy(out, y * w * channels, (y0 + y) * row + x0 * channels, (y0 + y) * row + (x0 + w) * channels);
		return { w, h, data: out };
	};
	return {
		left: strip(0, 0, PAD, SOURCE_PX),
		right: strip(SOURCE_PX - PAD, 0, PAD, SOURCE_PX),
		top: strip(0, 0, SOURCE_PX, PAD),
		bottom: strip(0, SOURCE_PX - PAD, SOURCE_PX, PAD),
	};
}

/** Source tile padded with its neighbours' edges: longitudes wrap, poles repeat their last row. */
function padded(data, channels, neighbour) {
	const size = SOURCE_PX + 2 * PAD;
	const out = Buffer.alloc(size * size * channels);
	const put = (x0, y0, src, sx, sy, w, h) => {
		for (let y = 0; y < h; y++) {
			const from = ((sy + y) * src.w + sx) * channels;
			src.data.copy(out, ((y0 + y) * size + x0) * channels, from, from + w * channels);
		}
	};
	put(PAD, PAD, { w: SOURCE_PX, data }, 0, 0, SOURCE_PX, SOURCE_PX);
	put(0, PAD, neighbour(-1, 0).right, 0, 0, PAD, SOURCE_PX);
	put(PAD + SOURCE_PX, PAD, neighbour(1, 0).left, 0, 0, PAD, SOURCE_PX);
	for (const [dy, y0, side] of [[-1, 0, 'bottom'], [1, PAD + SOURCE_PX, 'top']]) {
		const n = neighbour(0, dy);
		if (n) {
			put(PAD, y0, n[side], 0, 0, SOURCE_PX, PAD);
			put(0, y0, neighbour(-1, dy)[side], SOURCE_PX - PAD, 0, PAD, PAD);
			put(PAD + SOURCE_PX, y0, neighbour(1, dy)[side], 0, 0, PAD, PAD);
		} else {
			const edgeRow = dy < 0 ? PAD : PAD + SOURCE_PX - 1;
			for (let y = 0; y < PAD; y++) out.copy(out, (y0 + y) * size * channels, edgeRow * size * channels, (edgeRow + 1) * size * channels);
		}
	}
	return out;
}

/** Natural Earth ocean and lakes over a source tile, water = 255, rasterized in quarters. */
async function waterMask(geo, column, row) {
	const lon0 = -180 + 90 * column;
	const lat0 = 90 - 90 * row;
	const deg = 90 / SOURCE_PX;
	const half = SOURCE_PX / 2;
	const out = Buffer.alloc(SOURCE_PX * SOURCE_PX);
	for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
		const west = lon0 + qx * half * deg;
		const north = lat0 - qy * half * deg;
		const east = west + half * deg;
		const south = north - half * deg;
		const parts = [];
		for (const ring of geo.rings) {
			const [minX, minY, maxX, maxY] = ring.bbox;
			if (maxX < west || minX > east || maxY < south || minY > north) continue;
			let d = '';
			for (let i = 0; i < ring.points.length; i += 2) {
				const x = (ring.points[i] - west) / deg;
				const y = (north - ring.points[i + 1]) / deg;
				d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
			}
			parts.push(`${d}Z`);
		}
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${half}" height="${half}">` +
			`<rect width="100%" height="100%" fill="#000"/><path fill="#fff" fill-rule="evenodd" d="${parts.join('')}"/></svg>`;
		const { data, info } = await sharp(Buffer.from(svg), { limitInputPixels: false, unlimited: true }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
		if (info.channels !== 1) throw new Error(`water mask: ${info.channels} channels`);
		for (let y = 0; y < half; y++) data.copy(out, (qy * half + y) * SOURCE_PX + qx * half, y * half, (y + 1) * half);
	}
	return out;
}

async function loadGeo() {
	const rings = [];
	for (const name of ['ocean', 'lakes']) {
		const src = SOURCES[name];
		const file = await fetchPinned(src.url, src.bytes, src.sha256, CACHE_DIR);
		for (const feature of JSON.parse(await readFile(file, 'utf8')).features) {
			const { type, coordinates } = feature.geometry;
			for (const polygon of type === 'Polygon' ? [coordinates] : coordinates) {
				for (const ring of polygon) {
					const points = ring.flat();
					const bbox = [Infinity, Infinity, -Infinity, -Infinity];
					for (let i = 0; i < points.length; i += 2) {
						bbox[0] = Math.min(bbox[0], points[i]);
						bbox[1] = Math.min(bbox[1], points[i + 1]);
						bbox[2] = Math.max(bbox[2], points[i]);
						bbox[3] = Math.max(bbox[3], points[i + 1]);
					}
					rings.push({ points, bbox });
				}
			}
		}
	}
	return { rings };
}

/** Centred Lanczos 3 reduction; one-channel input must be forced back to one channel. */
async function downsample(data, channels, factor) {
	const size = SOURCE_PX + 2 * PAD;
	if (factor === 1) return data;
	let image = sharp(data, { raw: { width: size, height: size, channels }, limitInputPixels: false }).resize(size / factor, size / factor, { kernel: 'lanczos3' });
	if (channels === 1) image = image.toColourspace('b-w');
	const { data: out, info } = await image.raw().toBuffer({ resolveWithObject: true });
	if (info.channels !== channels) throw new Error(`downsample: ${info.channels} channels instead of ${channels}`);
	return out;
}

/** One tile with its border; at a pole the border row repeats the last row of content. */
function cut(data, channels, size, x0, y0, pole) {
	const span = TILE + 2 * BORDER;
	const row = span * channels;
	const out = Buffer.alloc(span * row);
	for (let y = 0; y < span; y++) data.copy(out, y * row, ((y0 + y) * size + x0) * channels, ((y0 + y) * size + x0 + span) * channels);
	if (pole === 'north') out.copy(out, 0, BORDER * row, (BORDER + 1) * row);
	if (pole === 'south') out.copy(out, (span - 1) * row, (span - 1 - BORDER) * row, (span - BORDER) * row);
	return out;
}

/** Spread of the luma within a tile, and the share of water texels when a mask is given. */
function stats(rgb, mask) {
	let min = 255;
	let max = 0;
	let water = 0;
	const n = rgb.length / 3;
	for (let i = 0; i < n; i++) {
		const luma = (rgb[i * 3] * 54 + rgb[i * 3 + 1] * 183 + rgb[i * 3 + 2] * 19) >> 8;
		if (luma < min) min = luma;
		if (luma > max) max = luma;
		if (mask && mask[i] > 127) water++;
	}
	return { range: max - min, max, water: mask ? water / n : null };
}

/** A tile holds nothing the global texture lacks: open water by day, unlit dark by night. */
const FLAT = {
	day: (s) => s.water === 1 && s.range <= 6,
	night: (s) => s.max <= 24 && s.range <= 8,
};

function encode(rgb, mask) {
	const span = TILE + 2 * BORDER;
	if (!mask) return sharp(rgb, { raw: { width: span, height: span, channels: 3 } }).webp({ quality: 85, effort: 4 }).toBuffer();
	const rgba = Buffer.alloc(span * span * 4);
	for (let k = 0; k < span * span; k++) {
		rgba[k * 4] = rgb[k * 3];
		rgba[k * 4 + 1] = rgb[k * 3 + 1];
		rgba[k * 4 + 2] = rgb[k * 3 + 2];
		rgba[k * 4 + 3] = mask[k];
	}
	return sharp(rgba, { raw: { width: span, height: span, channels: 4 } }).webp({ quality: 85, alphaQuality: 100, exact: true, effort: 4 }).toBuffer();
}

async function pool(items, limit, work) {
	let next = 0;
	await Promise.all(Array.from({ length: limit }, async () => {
		while (next < items.length) await work(items[next++]);
	}));
}

async function main() {
	const started = performance.now();
	const sourceDir = join(CACHE_DIR, '500m');
	await mkdir(sourceDir, { recursive: true });
	const geo = await loadGeo();
	await rm(OUT_DIR, { recursive: true, force: true });
	const sources = {};
	for (const name of ['ocean', 'lakes']) sources[`water/${name}`] = { url: SOURCES[name].url, bytes: SOURCES[name].bytes, sha256: SOURCES[name].sha256 };
	/** layer → level → { tiles, kept, bytes, hashes: Map<index, sha256> } */
	const built = {};
	const timings = {};

	for (const [layer, { levels }] of Object.entries(LAYERS)) {
		const files = {};
		for (const [tile, [bytes, hash]] of Object.entries(SOURCES[layer].files)) {
			files[tile] = await fetchPinned(SOURCES[layer].url(tile), bytes, hash, sourceDir);
			sources[`${layer}/${tile}`] = { url: SOURCES[layer].url(tile), bytes, sha256: hash };
		}
		const t0 = performance.now();
		const strips = {};
		const maskStrips = {};
		for (const tile of Object.keys(files)) {
			strips[tile] = edges(await decode(files[tile]), 3);
			if (LAYERS[layer].mask) maskStrips[tile] = edges(await waterMask(geo, COLUMNS.indexOf(tile[0]), ROWS.indexOf(tile[1])), 1);
		}
		built[layer] = Object.fromEntries(levels.map((z) => [z, { tiles: 0, kept: 0, bytes: 0, hashes: new Map() }]));

		for (const [column, c] of COLUMNS.entries()) {
			for (const [row, r] of ROWS.entries()) {
				const name = `${c}${r}`;
				if (ONLY && !ONLY.has(name)) continue;
				const t1 = performance.now();
				const neighbour = (from) => (dx, dy) => {
					const rr = row + dy;
					if (rr < 0 || rr >= ROWS.length) return null;
					return from[`${COLUMNS[(column + dx + 4) % 4]}${ROWS[rr]}`];
				};
				const rgb = padded(await decode(files[name]), 3, neighbour(strips));
				const mask = LAYERS[layer].mask ? padded(await waterMask(geo, column, row), 1, neighbour(maskStrips)) : null;
				// Finest level first, so a tile is kept whenever one of its children is.
				for (const z of [...levels].sort((a, b) => b - a)) {
					const factor = 2 ** (MAX_LEVEL - z);
					const size = (SOURCE_PX + 2 * PAD) / factor;
					const color = await downsample(rgb, 3, factor);
					const water = mask ? await downsample(mask, 1, factor) : null;
					const perSource = SOURCE_PX / factor / TILE;
					const children = built[layer][z + 1]?.hashes;
					const jobs = [];
					for (let j = 0; j < perSource; j++) for (let i = 0; i < perSource; i++) jobs.push([i, j]);
					const level = built[layer][z];
					await pool(jobs, Number(values.concurrency), async ([i, j]) => {
						const x0 = PAD / factor + TILE * i - BORDER;
						const y0 = PAD / factor + TILE * j - BORDER;
						const x = column * perSource + i;
						const y = row * perSource + j;
						const pole = y === 0 ? 'north' : y === rows(z) - 1 ? 'south' : null;
						const tileRgb = cut(color, 3, size, x0, y0, pole);
						const tileMask = water ? cut(water, 1, size, x0, y0, pole) : null;
						level.tiles++;
						const hasChild = children && [0, 1].some((dy) => [0, 1].some((dx) => children.has((2 * y + dy) * columns(z + 1) + 2 * x + dx)));
						if (!hasChild && FLAT[layer](stats(tileRgb, tileMask))) return;
						const webp = await encode(tileRgb, tileMask);
						const file = join(OUT_DIR, tilePath(layer, z, x, y));
						await mkdir(dirname(file), { recursive: true });
						await writeFile(file, webp);
						level.kept++;
						level.bytes += webp.length;
						level.hashes.set(y * columns(z) + x, sha256(webp));
					});
				}
				console.log(`${layer} ${name}: ${((performance.now() - t1) / 1000).toFixed(0)} s`);
			}
		}
		timings[layer] = Math.round((performance.now() - t0) / 1000);
	}

	const digest = createHash('sha256');
	const manifest = {
		version: SURFACE_VERSION,
		path: PATH,
		tileTexels: TILE,
		border: BORDER,
		maxLevel: MAX_LEVEL,
		attribution: ATTRIBUTION,
		layers: Object.fromEntries(Object.entries(LAYERS).map(([layer, l]) => [layer, { levels: l.levels, encoding: l.encoding }])),
		levels: {},
		sources,
		tools: { node: process.versions.node, sharp: sharp.versions.sharp, vips: sharp.versions.vips, webp: sharp.versions.webp },
	};
	for (const z of LEVELS) {
		const entry = { columns: columns(z), rows: rows(z), degrees: 360 / columns(z), texelKm: Number(((40075 / columns(z)) / TILE).toFixed(3)), layers: {} };
		for (const layer of Object.keys(LAYERS)) {
			const level = built[layer][z];
			if (!level) continue;
			const bits = new Uint8Array(Math.ceil((columns(z) * rows(z)) / 8));
			for (const index of [...level.hashes.keys()].sort((a, b) => a - b)) {
				bits[index >> 3] |= 1 << (index & 7);
				digest.update(`${layer}/${z}/${index} ${level.hashes.get(index)}\n`);
			}
			entry.layers[layer] = { tiles: level.tiles, kept: level.kept, bytes: level.bytes, present: Buffer.from(bits).toString('base64') };
		}
		manifest.levels[z] = entry;
	}
	manifest.digest = digest.digest('hex');
	await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	const seconds = Math.round((performance.now() - started) / 1000);
	await writeFile(join(OUT_DIR, '..', 'surface-build.json'), `${JSON.stringify({ seconds, layers: timings, digest: manifest.digest }, null, '\t')}\n`);

	const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
	console.table(Object.fromEntries(LEVELS.flatMap((z) => Object.keys(LAYERS).filter((l) => built[l][z]).map((layer) => {
		const t = built[layer][z];
		return [`${layer} z${z}`, { tiles: t.tiles, kept: t.kept, size: mb(t.bytes), perTile: `${(t.bytes / Math.max(1, t.kept) / 1e3).toFixed(1)} kB` }];
	}))));
	console.log(`${seconds} s, digest ${manifest.digest.slice(0, 16)}, output: ${OUT_DIR}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
