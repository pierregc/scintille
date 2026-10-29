// Builds the soundscape: seamless ambient loops and short crackles, all from CC0 recordings.
// Usage: pnpm -C web sound (needs ffmpeg with libmp3lame)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, '../../public/sound');
const CATALOG = join(ROOT, '../../src/globe/sound/catalog.json');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const SR = 44100;
/** Seconds of loop kept before and after the loop, so encoder padding never reaches the loop points. */
const PAD = 0.5;
const CROSSFADE = 4;
const TRACK_RMS_DB = -24;
const CRACKLES = 24;
const CRACKLE_S = 0.26;
/** Longest segment kept per track: a decoded track costs memory for as long as it plays. */
const MAX_SEGMENT_S = 84;

const freesound = (path) => `https://cdn.freesound.org/previews/${path}-hq.mp3`;

/** Freesound HQ previews, all CC0. A cached file is reused only if its size and SHA-256 match. */
const TRACKS = [
	{ id: '700896', title: 'Cosmic Ray (Ambient)', author: 'younoise', src: '700/700896_2346185', from: 4, to: 38 },
	{ id: '402338', title: 'ps Calm Aurorae', author: 'arseniiv', src: '402/402338_1951924', from: 2, to: 94 },
	{ id: '384388', title: 'Peaceful Drone', author: 'mricken1', src: '384/384388_7043106', from: 25, to: 140 },
	{ id: '425984', title: 'Space Drone Ambience 01', author: 'Magmi.Soundtracks', src: '425/425984_6900479', from: 17, to: 100 },
	{ id: '435147', title: 'Ambient Drone 21.07.2018', author: 'kickhat', src: '435/435147_4322723', from: 2, to: 104 },
	{ id: '543228', title: 'Angelic Guitar Pad', author: 'LeSystemPerv', src: '543/543228_9986925', from: 5, to: 140 },
	{ id: '609769', title: 'Calm airy tension drone', author: 'xkeril', src: '609/609769_13504080', from: 3, to: 42 },
	{ id: '683324', title: 'Aeons Whisper Pad', author: 'LogicMoon', src: '683/683324_462105', from: 1, to: 76 },
	{ id: '792042', title: 'gsharp major 7, ember proxima', author: 'Phrakture', src: '792/792042_468390', from: 10, to: 120 },
	{ id: '870290', title: 'Morning Relaxing Ambient Improvisation', author: 'bassimat', src: '870/870290_15636277', from: 2, to: 120 },
	{ id: '876072', title: 'Ambient Frozen Ice Ethereal Floating Landscape', author: 'bassimat', src: '876/876072_15636277', from: 2, to: 64 },
];
const STATIC = { id: '875011', title: 'Electrical Static, crackles and pops', src: '875/875011_19181807' };

const PINS = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));

function run(args, input) {
	const res = spawnSync(FFMPEG, ['-v', 'error', ...args], { input, maxBuffer: 1 << 30 });
	if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
	return res.stdout;
}

async function source(id, path) {
	const file = join(CACHE_DIR, `${id}.mp3`);
	const pin = PINS[id];
	const sha = async () => createHash('sha256').update(await readFile(file)).digest('hex');
	try {
		if ((await stat(file)).size === pin.bytes && (await sha()) === pin.sha256) return file;
	} catch {
		// Not cached yet.
	}
	console.log(`download: ${freesound(path)}`);
	const res = await fetch(freesound(path));
	if (!res.ok) throw new Error(`download failed (${res.status}): ${path}`);
	await writeFile(file, Buffer.from(await res.arrayBuffer()));
	if ((await stat(file)).size !== pin.bytes || (await sha()) !== pin.sha256) throw new Error(`${id} does not match its pin`);
	return file;
}

/** Decodes to interleaved float32 at SR. */
function decode(file, channels, filter) {
	const out = run(['-i', file, '-ac', String(channels), '-ar', String(SR), ...(filter ? ['-af', filter] : []), '-f', 'f32le', '-']);
	return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}

async function encode(samples, channels, kbps, path) {
	await mkdir(dirname(path), { recursive: true });
	run(['-y', '-f', 'f32le', '-ar', String(SR), '-ac', String(channels), '-i', '-', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, path],
		Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
	return (await stat(path)).size;
}

const rmsDb = (x) => 10 * Math.log10(x.reduce((s, v) => s + v * v, 0) / x.length);

/** Stereo segment crossfaded tail into head (equal power), wrapped with PAD seconds each side. */
function seamless(x) {
	const frames = x.length / 2;
	const n = CROSSFADE * SR;
	const body = x.slice(0, (frames - n) * 2);
	for (let i = 0; i < n; i++) {
		const a = (i / n) * (Math.PI / 2);
		for (let c = 0; c < 2; c++) body[i * 2 + c] = x[(frames - n + i) * 2 + c] * Math.cos(a) + x[i * 2 + c] * Math.sin(a);
	}
	const p = PAD * SR * 2;
	const out = new Float32Array(body.length + 2 * p);
	out.set(body.subarray(body.length - p), 0);
	out.set(body, p);
	out.set(body.subarray(0, p), p + body.length);
	return { samples: out, loop: body.length / 2 / SR };
}

/** Sharp attacks: a rise of more than 6 dB in 10 ms, well above the noise floor, at least 120 ms apart. */
function attacks(x, count) {
	const w = SR / 100;
	const db = [];
	for (let i = 0; i + w <= x.length; i += w) {
		let s = 0;
		for (let j = i; j < i + w; j++) s += x[j] * x[j];
		db.push(10 * Math.log10(s / w + 1e-18));
	}
	const floor = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.3)];
	const found = [];
	for (let i = 1; i < db.length; i++) if (db[i] - db[i - 1] > 6 && db[i] > floor + 12) found.push(i);
	const picked = [];
	for (const i of found.sort((a, b) => db[b] - db[a])) {
		if (picked.every((j) => Math.abs(i - j) >= 12)) picked.push(i);
		if (picked.length === count) break;
	}
	return picked.sort((a, b) => a - b).map((i) => (i - 1) * w);
}

function crackle(x, start) {
	const g = x.slice(start, start + Math.round(CRACKLE_S * SR));
	const fin = Math.round(0.003 * SR);
	const fout = Math.round(0.16 * SR);
	for (let i = 0; i < fin; i++) g[i] *= i / fin;
	for (let i = 0; i < fout; i++) g[g.length - fout + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fout);
	const peak = g.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
	const k = 10 ** (-3 / 20) / peak;
	return g.map((v) => v * k);
}

await mkdir(CACHE_DIR, { recursive: true });
await rm(OUT_DIR, { recursive: true, force: true });
const catalog = { pad: PAD, tracks: [], crackles: [], sources: [] };

for (const t of TRACKS) {
	const file = await source(t.id, t.src);
	const all = decode(file, 2, 'highpass=f=35');
	const x = all.slice(t.from * SR * 2, Math.min(t.to, t.from + MAX_SEGMENT_S) * SR * 2);
	const k = 10 ** ((TRACK_RMS_DB - rmsDb(x)) / 20);
	for (let i = 0; i < x.length; i++) x[i] = Math.max(-0.98, Math.min(0.98, x[i] * k));
	const { samples, loop } = seamless(x);
	const bytes = await encode(samples, 2, 96, join(OUT_DIR, 'tracks', `${t.id}.mp3`));
	catalog.tracks.push({ id: t.id, loop, bytes });
	catalog.sources.push({ id: t.id, title: t.title, author: t.author, url: `https://freesound.org/s/${t.id}/`, license: 'CC0-1.0' });
	console.log(`track ${t.id}: ${loop.toFixed(1)} s loop, ${(bytes / 1e6).toFixed(2)} MB`);
}

const staticFile = await source(STATIC.id, STATIC.src);
const noise = decode(staticFile, 1, 'highpass=f=900,lowpass=f=9000');
const starts = attacks(noise, CRACKLES);
for (const [i, start] of starts.entries()) {
	const bytes = await encode(crackle(noise, start), 1, 64, join(OUT_DIR, 'crackles', `${String(i).padStart(2, '0')}.mp3`));
	catalog.crackles.push({ at: Math.round((start / SR) * 100) / 100, bytes });
}
catalog.sources.push({ id: STATIC.id, title: STATIC.title, author: 'cb9382', url: `https://freesound.org/s/${STATIC.id}/`, license: 'CC0-1.0' });

await writeFile(CATALOG, `${JSON.stringify(catalog, null, '\t')}\n`);
const total = [...catalog.tracks, ...catalog.crackles].reduce((s, f) => s + f.bytes, 0);
console.log(`${catalog.tracks.length} tracks, ${catalog.crackles.length} crackles, ${(total / 1e6).toFixed(1)} MB`);
