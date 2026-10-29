// Checks a built surface pyramid: manifest against files, tile borders, poles, antimeridian, and the
// alignment of day, night, water mask and the global fallback. Usage: node scripts/textures/check-tiles.mjs [--out <dir>]
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { BORDER, LAYERS, LEVELS, TILE, columns, rows, tilePath } from './surface.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const FALLBACK = 'https://data.scintille.app/textures/v2/4k';
const SPAN = TILE + 2 * BORDER;
const SHIFTS = 2;
const SAMPLES = 240;

const { values } = parseArgs({ options: { out: { type: 'string', default: join(ROOT, 'out', 'surface') } } });
const DIR = values.out;
const failures = [];
const fail = (message) => {
	failures.push(message);
	console.error(`FAIL ${message}`);
};

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function presence(manifest, layer, z) {
	const entry = manifest.levels[z]?.layers[layer];
	if (!entry) return () => false;
	const bits = Buffer.from(entry.present, 'base64');
	return (x, y) => {
		const index = y * columns(z) + x;
		return (bits[index >> 3] & (1 << (index & 7))) !== 0;
	};
}

/** Files, byte counts, digest and the rule that a kept tile has kept ancestors. */
async function checkManifest(manifest) {
	const onDisk = new Set((await readdir(DIR, { recursive: true, withFileTypes: true }))
		.filter((e) => e.isFile() && e.name.endsWith('.webp'))
		.map((e) => relative(DIR, join(e.parentPath, e.name)).split(sep).join('/')));
	const digest = createHash('sha256');
	let listed = 0;
	for (const z of LEVELS) {
		for (const [layer, { levels }] of Object.entries(LAYERS)) {
			if (!levels.includes(z)) continue;
			const has = presence(manifest, layer, z);
			const parent = presence(manifest, layer, z - 1);
			let bytes = 0;
			let kept = 0;
			for (let y = 0; y < rows(z); y++) {
				for (let x = 0; x < columns(z); x++) {
					if (!has(x, y)) continue;
					const path = tilePath(layer, z, x, y);
					if (!onDisk.delete(path)) {
						fail(`${path} listed but missing`);
						continue;
					}
					const data = await readFile(join(DIR, path));
					bytes += data.length;
					kept++;
					digest.update(`${layer}/${z}/${y * columns(z) + x} ${sha256(data)}\n`);
					if (z > levels[0] && !parent(x >> 1, y >> 1)) fail(`${path} kept under a missing parent`);
				}
			}
			listed += kept;
			const entry = manifest.levels[z].layers[layer];
			if (entry.kept !== kept || entry.bytes !== bytes) fail(`${layer} z${z}: manifest ${entry.kept} tiles ${entry.bytes} B, disk ${kept} tiles ${bytes} B`);
		}
	}
	for (const path of onDisk) fail(`${path} on disk but not listed`);
	if (digest.digest('hex') !== manifest.digest) fail('digest does not match the tiles');
	return listed;
}

async function decode(layer, z, x, y) {
	const image = sharp(join(DIR, tilePath(layer, z, x, y)));
	const { data, info } = await (layer === 'day' ? image.ensureAlpha() : image.removeAlpha()).raw().toBuffer({ resolveWithObject: true });
	if (info.width !== SPAN || info.height !== SPAN) fail(`${tilePath(layer, z, x, y)}: ${info.width}x${info.height}`);
	return { data, channels: info.channels };
}

/** Texels along a column (`axis` 0) or row (`axis` 1) of a tile. */
function line(tile, axis, index) {
	const out = [];
	for (let k = 0; k < SPAN; k++) {
		const [x, y] = axis === 0 ? [index, k] : [k, index];
		out.push(tile.data.subarray((y * SPAN + x) * tile.channels, (y * SPAN + x + 1) * tile.channels));
	}
	return out;
}

/** Mean absolute RGB difference and alpha mismatches between two lines of texels. */
function compare(a, b) {
	let rgb = 0;
	let alpha = 0;
	for (let k = 0; k < a.length; k++) {
		for (let c = 0; c < 3; c++) rgb += Math.abs(a[k][c] - b[k][c]);
		if (a[k].length === 4 && a[k][3] !== b[k][3]) alpha++;
	}
	return { rgb: rgb / (3 * a.length), alpha };
}

function seamKind(z, axis, x, y) {
	if (axis === 0 && x === columns(z) - 1) return 'antimeridian';
	if (axis === 0 && (x + 1) % (columns(z) / 4) === 0) return 'source';
	if (axis === 1 && y + 1 === rows(z) / 2) return 'source';
	return 'interior';
}

/**
 * Each shared edge: the border texels of a tile must repeat its neighbour's first content texels,
 * exactly for the water mask, within compression noise for colour. The texels one further are the control.
 */
async function checkBorders(manifest) {
	const report = {};
	for (const [layer, { levels }] of Object.entries(LAYERS)) {
		for (const z of levels) {
			const has = presence(manifest, layer, z);
			const sums = {};
			const add = (kind, match, control) => {
				const s = (sums[kind] ??= { pairs: 0, rgb: 0, worst: 0, control: 0, alpha: 0 });
				s.pairs++;
				s.rgb += match.rgb;
				s.worst = Math.max(s.worst, match.rgb);
				s.control += control.rgb;
				s.alpha += match.alpha;
			};
			const cache = new Map();
			const get = async (x, y) => {
				const key = `${x},${y}`;
				if (!cache.has(key)) cache.set(key, await decode(layer, z, x, y));
				return cache.get(key);
			};
			for (let y = 0; y < rows(z); y++) {
				for (let x = 0; x < columns(z); x++) {
					if (!has(x, y)) continue;
					const a = await get(x, y);
					const east = (x + 1) % columns(z);
					if (has(east, y)) {
						const b = await get(east, y);
						const kind = seamKind(z, 0, x, y);
						add(kind, compare(line(a, 0, SPAN - 1), line(b, 0, 1)), compare(line(a, 0, SPAN - 1), line(b, 0, 2)));
						add(kind, compare(line(b, 0, 0), line(a, 0, SPAN - 2)), compare(line(b, 0, 0), line(a, 0, SPAN - 3)));
					}
					if (y + 1 < rows(z) && has(x, y + 1)) {
						const b = await get(x, y + 1);
						const kind = seamKind(z, 1, x, y);
						add(kind, compare(line(a, 1, SPAN - 1), line(b, 1, 1)), compare(line(a, 1, SPAN - 1), line(b, 1, 2)));
						add(kind, compare(line(b, 1, 0), line(a, 1, SPAN - 2)), compare(line(b, 1, 0), line(a, 1, SPAN - 3)));
					}
					if (y === 0 || y === rows(z) - 1) {
						const [border, first, second] = y === 0 ? [0, 1, 2] : [SPAN - 1, SPAN - 2, SPAN - 3];
						add(y === 0 ? 'north pole' : 'south pole', compare(line(a, 1, border), line(a, 1, first)), compare(line(a, 1, border), line(a, 1, second)));
					}
				}
				for (const key of cache.keys()) if (Number(key.split(',')[1]) < y + 1) cache.delete(key);
			}
			const interior = sums.interior ? sums.interior.rgb / sums.interior.pairs : 0;
			for (const [kind, s] of Object.entries(sums)) {
				const r = { pairs: s.pairs, rgbMean: +(s.rgb / s.pairs).toFixed(2), rgbWorst: +s.worst.toFixed(2), controlMean: +(s.control / s.pairs).toFixed(2), alphaMismatches: s.alpha };
				report[`${layer} z${z} ${kind}`] = r;
				if (r.alphaMismatches) fail(`${layer} z${z} ${kind}: ${r.alphaMismatches} water mask texels differ from the texels they repeat`);
				// Lossy WebP leaves about 1 to 2 levels between copies of the same texel: a seam must not add to it.
				if (r.rgbMean > 2 || r.rgbMean > interior + 0.5) fail(`${layer} z${z} ${kind}: colour differs by ${r.rgbMean} (interior ${interior.toFixed(2)})`);
			}
		}
	}
	return report;
}

/** Normalised cross-correlation of two planes over a centred window, for every shift of b within ±SHIFTS. */
function correlate(a, b, width, height, margin) {
	const out = [];
	for (let dy = -SHIFTS; dy <= SHIFTS; dy++) {
		for (let dx = -SHIFTS; dx <= SHIFTS; dx++) {
			let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
			for (let y = margin; y < height - margin; y++) {
				for (let x = margin; x < width - margin; x++) {
					const va = a[y * width + x];
					const vb = b[(y + dy) * width + x + dx];
					sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; n++;
				}
			}
			const cov = sab / n - (sa / n) * (sb / n);
			out.push({ dx, dy, r: cov / Math.sqrt(Math.max(1e-9, (saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2))) });
		}
	}
	return out;
}

/** Edge strength, so that a shift is measured on coastlines rather than on the shape of the fields. */
function gradient(field) {
	const out = new Float32Array(field.length);
	for (let y = 1; y < SPAN - 1; y++) {
		for (let x = 1; x < SPAN - 1; x++) {
			const k = y * SPAN + x;
			out[k] = Math.abs(field[k + 1] - field[k - 1]) + Math.abs(field[k + SPAN] - field[k - SPAN]);
		}
	}
	return out;
}

/** Best shift of b against a in texels, refined with a parabola through the neighbours of the peak. */
function peak(scores) {
	const at = (dx, dy) => scores.find((s) => s.dx === dx && s.dy === dy)?.r;
	const best = scores.reduce((m, s) => (s.r > m.r ? s : m));
	const refine = (minus, centre, plus) => (minus === undefined || plus === undefined ? 0 : (minus - plus) / (2 * (minus - 2 * centre + plus)));
	return {
		dx: +(best.dx + refine(at(best.dx - 1, best.dy), best.r, at(best.dx + 1, best.dy))).toFixed(2),
		dy: +(best.dy + refine(at(best.dx, best.dy - 1), best.r, at(best.dx, best.dy + 1))).toFixed(2),
		r: +best.r.toFixed(3),
		r0: +at(0, 0).toFixed(3),
	};
}

function sumScores(list) {
	const total = list[0].map((s) => ({ ...s, r: 0 }));
	for (const scores of list) scores.forEach((s, i) => (total[i].r += s.r / list.length));
	return total;
}

/**
 * Coast tiles: coastlines of the water mask against the edges of the day colour (distance from the open
 * ocean colour) and of the night luma. A peak away from (0, 0) means a layer is shifted.
 */
async function checkAlignment(manifest) {
	const report = {};
	for (const z of LAYERS.day.levels) {
		const day = presence(manifest, 'day', z);
		const night = presence(manifest, 'night', z);
		const coasts = [];
		for (let y = 0; y < rows(z); y++) for (let x = 0; x < columns(z); x++) if (day(x, y)) coasts.push([x, y]);
		const step = Math.max(1, Math.floor(coasts.length / (SAMPLES * 8)));
		const dayScores = [];
		const nightScores = [];
		for (let i = 0; i < coasts.length && dayScores.length < SAMPLES; i += step) {
			const [x, y] = coasts[i];
			const tile = await decode('day', z, x, y);
			const n = SPAN * SPAN;
			const land = new Float32Array(n);
			let water = 0;
			const ocean = [0, 0, 0];
			for (let k = 0; k < n; k++) {
				land[k] = 255 - tile.data[k * 4 + 3];
				if (tile.data[k * 4 + 3] === 255) {
					water++;
					for (let c = 0; c < 3; c++) ocean[c] += tile.data[k * 4 + c];
				}
			}
			if (water < 0.2 * n || water > 0.8 * n) continue;
			for (let c = 0; c < 3; c++) ocean[c] /= water;
			const colour = new Float32Array(n);
			for (let k = 0; k < n; k++) colour[k] = Math.hypot(tile.data[k * 4] - ocean[0], tile.data[k * 4 + 1] - ocean[1], tile.data[k * 4 + 2] - ocean[2]);
			const coast = gradient(land);
			dayScores.push(correlate(coast, gradient(colour), SPAN, SPAN, BORDER + SHIFTS + 1));
			if (night(x, y)) {
				const lights = await decode('night', z, x, y);
				const luma = new Float32Array(n);
				for (let k = 0; k < n; k++) luma[k] = lights.data[k * 3] * 0.2126 + lights.data[k * 3 + 1] * 0.7152 + lights.data[k * 3 + 2] * 0.0722;
				nightScores.push(correlate(coast, gradient(luma), SPAN, SPAN, BORDER + SHIFTS + 1));
			}
		}
		const result = { coastTiles: dayScores.length };
		if (dayScores.length) result.dayAgainstMask = peak(sumScores(dayScores));
		if (nightScores.length) result.nightAgainstMask = { tiles: nightScores.length, ...peak(sumScores(nightScores)) };
		report[`z${z}`] = result;
		for (const [name, p] of Object.entries(result)) {
			// Natural Earth and the NASA grids agree within about one 15″ pixel: a whole texel apart means a layer is misplaced.
			if (typeof p === 'object' && (Math.abs(p.dx) >= 1 || Math.abs(p.dy) >= 1)) fail(`z${z} ${name}: shifted by (${p.dx}, ${p.dy}) texels`);
		}
		if (!dayScores.length) fail(`z${z}: no coast tile to check the water mask against`);
	}
	return report;
}

/** Level 2 mosaics reduced to the 4k fallback grid, against the published global day, night and mask textures. */
async function checkFallback(manifest) {
	const z = 2;
	const width = columns(z) * TILE;
	const height = rows(z) * TILE;
	const planes = { day: Buffer.alloc(width * height * 3), mask: Buffer.alloc(width * height), night: Buffer.alloc(width * height * 3), weight: Buffer.alloc(width * height) };
	const day = presence(manifest, 'day', z);
	const night = presence(manifest, 'night', z);
	for (let y = 0; y < rows(z); y++) {
		for (let x = 0; x < columns(z); x++) {
			if (!day(x, y) || !night(x, y)) continue;
			const d = await decode('day', z, x, y);
			const n = await decode('night', z, x, y);
			for (let j = 0; j < TILE; j++) {
				for (let i = 0; i < TILE; i++) {
					const src = (j + BORDER) * SPAN + i + BORDER;
					const dst = (y * TILE + j) * width + x * TILE + i;
					for (let c = 0; c < 3; c++) {
						planes.day[dst * 3 + c] = d.data[src * 4 + c];
						planes.night[dst * 3 + c] = n.data[src * 3 + c];
					}
					planes.mask[dst] = d.data[src * 4 + 3];
					planes.weight[dst] = 255;
				}
			}
		}
	}
	const W = 4096;
	const H = 2048;
	const reduce = async (data, channels) => {
		const { data: out } = await sharp(data, { raw: { width, height, channels }, limitInputPixels: false })
			.resize(W, H, { kernel: 'lanczos3', fit: 'fill' }).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
		return out;
	};
	const fetchPlane = async (name) => {
		const res = await fetch(`${FALLBACK}/${name}.webp`);
		if (!res.ok) throw new Error(`fallback ${name}: ${res.status}`);
		const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
		if (info.width !== W || info.height !== H) throw new Error(`fallback ${name}: ${info.width}x${info.height}`);
		return data;
	};
	const weight = await reduce(planes.weight, 1);
	const report = {};
	for (const [name, channels] of [['day', 3], ['night', 3], ['mask', 1]]) {
		const tiles = await reduce(planes[name], channels);
		const global = await fetchPlane(name);
		// Shifts are measured on the rows with tiles, as two planes where missing tiles hold the fallback itself.
		const a = new Float32Array(W * H);
		const b = new Float32Array(W * H);
		for (let k = 0; k < W * H; k++) {
			a[k] = weight[k] === 255 ? tiles[k] : global[k];
			b[k] = global[k];
		}
		report[name] = peak(correlate(a, b, W, H, SHIFTS + 2));
		const p = report[name];
		if (Math.abs(p.dx) > 0.25 || Math.abs(p.dy) > 0.25) fail(`fallback ${name}: level 2 shifted by (${p.dx}, ${p.dy}) 4k texels`);
	}
	return report;
}

async function main() {
	const started = performance.now();
	const manifest = JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8'));
	const tiles = await checkManifest(manifest);
	console.log(`manifest: ${tiles} tiles`);
	const borders = await checkBorders(manifest);
	console.table(borders);
	const alignment = await checkAlignment(manifest);
	console.log(JSON.stringify(alignment, null, 1));
	const fallback = await checkFallback(manifest);
	console.log(JSON.stringify(fallback, null, 1));
	const seconds = Math.round((performance.now() - started) / 1000);
	await writeFile(join(DIR, '..', 'surface-check.json'), `${JSON.stringify({ digest: manifest.digest, tiles, seconds, failures, borders, alignment, fallback }, null, '\t')}\n`);
	console.log(failures.length ? `${failures.length} failures` : `all checks passed in ${seconds} s`);
	process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
