// Measures the immersive storm view on the reference storms (docs/immersive-view.md).
// Usage: node scripts/bench.mjs --refs ../docs/immersive/references.json --out <dir>
//   [--url https://scintille.app] [--profile desktop|mobile] [--gl gpu|swiftshader] [--seconds 8]
//   [--storm <id>] [--afterglow <minutes>] [--no-clouds] [--headed] [--video]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, devices } from 'playwright';
import sharp from 'sharp';

const { values } = parseArgs({
	allowNegative: true,
	options: {
		refs: { type: 'string' },
		out: { type: 'string' },
		url: { type: 'string', default: 'https://scintille.app' },
		profile: { type: 'string', default: 'desktop' },
		gl: { type: 'string', default: 'gpu' },
		seconds: { type: 'string', default: '8' },
		storm: { type: 'string' },
		afterglow: { type: 'string' },
		clouds: { type: 'boolean', default: true },
		headed: { type: 'boolean', default: false },
		video: { type: 'boolean', default: false },
	},
});

if (!values.refs || !values.out) {
	process.stderr.write('usage: node scripts/bench.mjs --refs <references.json> --out <dir> [options]\n');
	process.exit(2);
}

const GL_ARGS = {
	gpu: ['--ignore-gpu-blocklist', '--enable-gpu'],
	swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const PROFILES = {
	desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 },
	mobile: Object.fromEntries(Object.entries(devices['iPhone 15']).filter(([key]) => key !== 'defaultBrowserType')),
};
if (!(values.gl in GL_ARGS)) throw new Error(`--gl must be one of ${Object.keys(GL_ARGS).join(', ')}`);
if (!(values.profile in PROFILES)) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);

const refs = JSON.parse(await readFile(values.refs, 'utf8'));
const seconds = Number(values.seconds);
const storms = refs.storms.filter((storm) => !values.storm || storm.id === values.storm);
const base = values.url.endsWith('/') ? values.url : `${values.url}/`;

/* global WebGL2RenderingContext, HTMLCanvasElement, window, localStorage, document */

/** Injected before the page runs: frame times, draw calls, instance counts and GPU allocations. */
function instrument() {
	const GL = WebGL2RenderingContext;
	const proto = GL.prototype;
	const BPP = {
		0x8058: 4, 0x8c43: 4, 0x8051: 4, 0x8229: 1, 0x822b: 2, 0x881a: 8, 0x8814: 16, 0x822d: 2, 0x822e: 4,
		0x822f: 4, 0x881b: 8, 0x81a6: 4, 0x88f0: 4, 0x8cac: 4, 0x81a5: 2, 0x8cad: 8, 0x8d48: 1,
		0x83f0: 0.5, 0x83f1: 0.5, 0x83f2: 1, 0x83f3: 1, 0x8e8c: 1, 0x8e8d: 1, 0x9274: 0.5, 0x9275: 0.5,
		0x9276: 0.5, 0x9277: 0.5, 0x9278: 1, 0x9279: 1, 0x9270: 0.5, 0x9271: 0.5, 0x9272: 1, 0x9273: 1,
		0x93b0: 1, 0x93d0: 1, 0x8d64: 0.5, 0x8c00: 0.5, 0x8c01: 0.25, 0x8c02: 0.5, 0x8c03: 0.25,
		0x8dbb: 0.5, 0x8dbc: 0.5, 0x8dbd: 1, 0x8dbe: 1,
	};
	const TYPE_BYTES = { 0x1401: 1, 0x140b: 2, 0x1406: 4, 0x8d61: 2, 0x1403: 2, 0x1405: 4 };
	const CHANNELS = { 0x1908: 4, 0x1907: 3, 0x1909: 1, 0x190a: 2, 0x1906: 1, 0x1903: 1, 0x8227: 2 };
	const bpp = (format, type) => BPP[format] ?? (CHANNELS[format] ?? 4) * (TYPE_BYTES[type] ?? 1);
	const errors = new Set();
	const textures = new Map();
	const buffers = new Map();
	const renderbuffers = new Map();
	const bound = { unit: 0, tex: new Map(), buf: new Map(), rb: null };
	const texKey = (target) => `${bound.unit}:${target === GL.TEXTURE_2D || target === GL.TEXTURE_2D_ARRAY || target === GL.TEXTURE_3D ? target : GL.TEXTURE_CUBE_MAP}`;
	const currentTexture = (target) => bound.tex.get(texKey(target));
	const setLevel = (target, level, bytes) => {
		const texture = currentTexture(target);
		if (!texture) return;
		const levels = textures.get(texture) ?? new Map();
		levels.set(`${target}:${level}`, bytes);
		textures.set(texture, levels);
	};
	const sourceSize = (source) => [source?.videoWidth || source?.naturalWidth || source?.displayWidth || source?.width || 0,
		source?.videoHeight || source?.naturalHeight || source?.displayHeight || source?.height || 0];
	const wrap = (name, after) => {
		const original = proto[name];
		proto[name] = function (...args) {
			const result = original.apply(this, args);
			try {
				after.call(this, args, result);
			} catch (error) {
				errors.add(`${name}: ${error}`);
			}
			return result;
		};
	};
	wrap('activeTexture', ([unit]) => { bound.unit = unit - GL.TEXTURE0; });
	wrap('bindTexture', ([target, texture]) => { bound.tex.set(texKey(target), texture); });
	wrap('deleteTexture', ([texture]) => { textures.delete(texture); });
	wrap('texImage2D', (args) => {
		const [target, level, format] = args;
		const [width, height, type] = args.length >= 8 ? [args[3], args[4], args[7]] : [...sourceSize(args[5]), args[4]];
		setLevel(target, level, width * height * bpp(format, type));
	});
	wrap('texImage3D', ([target, level, format, width, height, depth, , , type]) => {
		setLevel(target, level, width * height * depth * bpp(format, type));
	});
	wrap('compressedTexImage2D', (args) => {
		const [target, level, format, width, height] = args;
		setLevel(target, level, Math.max(width, 4) * Math.max(height, 4) * bpp(format));
	});
	wrap('texStorage2D', ([target, levels, format, width, height]) => {
		const faces = target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
		for (let level = 0; level < levels; level++) {
			const w = Math.max(1, width >> level);
			const h = Math.max(1, height >> level);
			setLevel(target, level, faces * Math.max(w, BPP[format] < 4 ? 4 : 1) * Math.max(h, BPP[format] < 4 ? 4 : 1) * bpp(format));
		}
	});
	wrap('texStorage3D', ([target, levels, format, width, height, depth]) => {
		for (let level = 0; level < levels; level++) {
			setLevel(target, level, Math.max(1, width >> level) * Math.max(1, height >> level) * (target === GL.TEXTURE_3D ? Math.max(1, depth >> level) : depth) * bpp(format));
		}
	});
	wrap('bindBuffer', ([target, buffer]) => { bound.buf.set(target, buffer); });
	wrap('deleteBuffer', ([buffer]) => { buffers.delete(buffer); });
	wrap('bufferData', ([target, data]) => {
		const buffer = bound.buf.get(target);
		if (buffer) buffers.set(buffer, typeof data === 'number' ? data : data?.byteLength ?? 0);
	});
	wrap('bindRenderbuffer', ([, renderbuffer]) => { bound.rb = renderbuffer; });
	wrap('deleteRenderbuffer', ([renderbuffer]) => { renderbuffers.delete(renderbuffer); });
	wrap('renderbufferStorage', ([, format, width, height]) => {
		if (bound.rb) renderbuffers.set(bound.rb, width * height * bpp(format));
	});
	wrap('renderbufferStorageMultisample', ([, samples, format, width, height]) => {
		if (bound.rb) renderbuffers.set(bound.rb, width * height * bpp(format) * Math.max(1, samples));
	});

	let frame = { work: 0, draws: 0, instanced: new Map() };
	const record = (kind, count, instances) => {
		frame.draws++;
		if (instances === undefined) return;
		const key = `${kind}:${count}`;
		frame.instanced.set(key, Math.max(frame.instanced.get(key) ?? 0, instances));
	};
	wrap('drawArrays', ([mode, , count]) => record(`arrays${mode}`, count));
	wrap('drawElements', ([mode, count]) => record(`elements${mode}`, count));
	wrap('drawArraysInstanced', ([mode, , count, instances]) => record(`arrays${mode}`, count, instances));
	wrap('drawElementsInstanced', ([mode, count, , , instances]) => record(`elements${mode}`, count, instances));

	const bench = {
		app: null,
		readyAt: null,
		frames: [],
		recording: false,
		sync: false,
		gl: null,
		errors,
		memory() {
			const sum = (map, f = (v) => v) => [...map.values()].reduce((total, value) => total + f(value), 0);
			const gl = bench.gl;
			const attributes = gl?.getContextAttributes();
			const pixels = gl ? gl.drawingBufferWidth * gl.drawingBufferHeight : 0;
			const samples = attributes?.antialias ? 4 : 1;
			return {
				textures: sum(textures, (levels) => sum(levels)),
				textureCount: textures.size,
				largestTextures: [...textures.values()].map((levels) => sum(levels)).sort((a, b) => b - a).slice(0, 8),
				buffers: sum(buffers),
				renderbuffers: sum(renderbuffers),
				drawingBuffer: pixels * (4 * 2 + (4 + 4) * samples),
				drawingBufferSize: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null,
			};
		},
	};
	const originalGetContext = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
		const context = originalGetContext.call(this, type, ...rest);
		if (type === 'webgl2' && context && this.isConnected && !bench.gl) bench.gl = context;
		return context;
	};
	const raf = window.requestAnimationFrame.bind(window);
	const pixel = new Uint8Array(4);
	window.requestAnimationFrame = (callback) => raf((time) => {
		if (!bench.recording) return callback(time);
		const start = performance.now();
		callback(time);
		if (bench.sync && bench.gl) bench.gl.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, pixel);
		frame.work += performance.now() - start;
	});
	const tick = (time) => {
		if (bench.recording) bench.frames.push({ time, work: frame.work, draws: frame.draws, instanced: Object.fromEntries(frame.instanced) });
		frame = { work: 0, draws: 0, instanced: new Map() };
		raf(tick);
	};
	raf(tick);
	window.addEventListener('globe:ready', (event) => {
		bench.app = event.detail;
		bench.readyAt = performance.now();
	});
	window.scintilleBench = bench;
}

function quantile(sorted, q) {
	if (sorted.length === 0) return null;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function frameStats(frames) {
	const intervals = frames.slice(1).map((f, i) => f.time - frames[i].time).sort((a, b) => a - b);
	const instanced = {};
	for (const f of frames) {
		for (const [key, value] of Object.entries(f.instanced)) instanced[key] = Math.max(instanced[key] ?? 0, value);
	}
	const draws = frames.map((f) => f.draws).sort((a, b) => a - b);
	const work = frames.slice(1).map((f) => f.work).sort((a, b) => a - b);
	const round = (x) => (x === null ? null : Math.round(x * 100) / 100);
	return {
		frames: frames.length,
		intervalP50Ms: round(quantile(intervals, 0.5)),
		intervalP95Ms: round(quantile(intervals, 0.95)),
		intervalMaxMs: round(intervals.at(-1) ?? null),
		over33Ms: intervals.filter((x) => x > 33.4).length,
		over50Ms: intervals.filter((x) => x > 50).length,
		workP50Ms: round(quantile(work, 0.5)),
		workP95Ms: round(quantile(work, 0.95)),
		workMaxMs: round(work.at(-1) ?? null),
		drawCallsP50: quantile(draws, 0.5),
		maxInstances: instanced,
	};
}

function category(url) {
	const path = new URL(url).pathname;
	if (/\/textures\//.test(path)) return 'earth';
	if (/clouds\//.test(path)) return 'clouds';
	if (/chunks\//.test(path) || /\.bin(\.gz)?$/.test(path)) return 'flashes';
	if (/storms\/|manifest|coverage|metrics/.test(path)) return 'metadata';
	if (/\.(js|css|woff2?)$/.test(path)) return 'code';
	return 'other';
}

const DATA = new Set(['earth', 'clouds', 'flashes', 'metadata']);

/** Bytes received by kind; waits for data requests to settle. */
class Transfer {
	#bytes = {};
	#pending = new Set();
	#last = performance.now();

	constructor(page) {
		page.on('request', (request) => {
			if (!/^https?:/.test(request.url()) || !DATA.has(category(request.url()))) return;
			this.#pending.add(request);
			this.#last = performance.now();
		});
		const done = async (request, failed) => {
			if (this.#pending.delete(request)) this.#last = performance.now();
			if (failed || !/^https?:/.test(request.url())) return;
			const sizes = await request.sizes().catch(() => null);
			if (!sizes) return;
			const key = category(request.url());
			this.#bytes[key] = (this.#bytes[key] ?? 0) + sizes.responseBodySize + sizes.responseHeadersSize;
		};
		page.on('requestfinished', (request) => done(request, false));
		page.on('requestfailed', (request) => done(request, true));
	}

	take() {
		const bytes = this.#bytes;
		this.#bytes = {};
		return { total: Object.values(bytes).reduce((a, b) => a + b, 0), ...bytes };
	}

	async idle(quietMs = 1500, timeoutMs = 30_000) {
		const deadline = performance.now() + timeoutMs;
		while (performance.now() < deadline) {
			if (this.#pending.size === 0 && performance.now() - this.#last > quietMs) return true;
			await delay(100);
		}
		return false;
	}
}

/** Frames over `ms`; with `sync`, each frame waits for the GPU so `work` is its CPU plus GPU cost. */
async function record(page, ms, sync = false) {
	await page.evaluate((s) => { const b = globalThis.scintilleBench; b.frames = []; b.sync = s; b.recording = true; }, sync);
	await page.waitForTimeout(ms);
	return page.evaluate(() => { const b = globalThis.scintilleBench; b.recording = false; return b.frames; });
}

/** Flashes inside the display window at the current scene time, from the app's ring. */
function activeFlashes() {
	const app = globalThis.scintilleBench.app;
	const { ring, delays } = app.debug;
	const now = app.clock.time();
	const d = delays();
	const span = Math.max(1, app.lightning.displayMinutes) * 60_000;
	let active = 0;
	let flicker = 0;
	for (let i = 0; i < ring.size; i++) {
		const s = ring.slot(i);
		const age = now - (ring.time[s] + d.ms[ring.source[s]]);
		if (age >= 0 && age < span) active++;
		if (age >= 0 && age < 750) flicker++;
	}
	return { held: ring.size, active, flicker, displayMinutes: app.lightning.displayMinutes, sceneTime: new Date(now).toISOString() };
}

/** Pose templates from the reference file, centred on the storm. */
function posesAt({ lat, lon }) {
	return Object.fromEntries(Object.entries(refs.poses).map(([name, pose]) => [name, pose === 'framed' ? pose : { lat, lon, ...pose }]));
}

/** Mean luminance (0 to 255) and share of near white pixels of a screenshot. */
async function brightness(png) {
	const { data, info } = await sharp(png).resize({ width: 640 }).greyscale().raw().toBuffer({ resolveWithObject: true });
	let sum = 0;
	let white = 0;
	for (const value of data) {
		sum += value;
		if (value >= 245) white++;
	}
	const pixels = info.width * info.height;
	return { mean: Math.round(sum / pixels), nearWhite: Math.round((white / pixels) * 1000) / 1000 };
}

function parseView(param) {
	const [lat, lon, altitude, tilt] = (param ?? '').split(',').map(Number);
	return [lat, lon, altitude, tilt].every(Number.isFinite) ? { lat, lon, altitude, tilt } : null;
}

function viewParam({ lat, lon, altitude, tilt }) {
	return [lat, lon, altitude, tilt].map((x) => Number(x).toFixed(3)).join(',');
}

async function benchStorm(browser, storm, outDir) {
	const context = await browser.newContext({
		...PROFILES[values.profile],
		...(values.video ? { recordVideo: { dir: outDir, size: { width: 1280, height: 720 } } } : {}),
	});
	await context.addInitScript(instrument);
	await context.addInitScript(({ minutes, clouds }) => {
		try {
			localStorage.setItem('scintille.display.minutes', String(minutes));
			localStorage.setItem('scintille.clouds.visible', clouds ? '1' : '0');
		} catch { /* private mode */ }
	}, { minutes: values.afterglow !== undefined ? Number(values.afterglow) : storm.afterglow ?? 0, clouds: values.clouds });
	const page = await context.newPage();
	page.setDefaultTimeout(120_000);
	page.on('console', (message) => { if (message.type() === 'error') process.stderr.write(`page: ${message.text()}\n`); });
	const transfer = new Transfer(page);
	const result = { id: storm.id, slug: storm.slug, time: storm.time, poses: {} };

	const first = new URL(base);
	first.searchParams.set('storm', storm.slug);
	first.searchParams.set('time', storm.time);
	first.searchParams.set('paused', '1');
	const started = performance.now();
	await page.goto(first.href);
	await page.waitForFunction(() => globalThis.scintilleBench?.app && !globalThis.scintilleBench.app.replay.state.loading && globalThis.scintilleBench.app.replay.state.selected);
	await transfer.idle();
	result.load = {
		readyMs: Math.round(await page.evaluate(() => globalThis.scintilleBench.readyAt)),
		settledMs: Math.round(performance.now() - started),
		bytes: transfer.take(),
		quality: await page.evaluate(() => document.querySelector('canvas')?.dataset.quality ?? null),
		renderer: await page.evaluate(() => {
			const gl = globalThis.scintilleBench.gl;
			const debug = gl?.getExtension('WEBGL_debug_renderer_info');
			return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
		}),
		framed: new URL(await page.evaluate(() => globalThis.scintilleBench.app.shareUrl())).searchParams.get('view'),
	};

	for (const [name, pose] of Object.entries(storm.poses ?? posesAt(storm.center))) {
		const target = pose === 'framed' ? parseView(result.load.framed) : pose;
		const flight = await page.evaluate(async (view) => {
			const b = globalThis.scintilleBench;
			b.frames = [];
			b.recording = true;
			const t0 = performance.now();
			const arrived = view ? await b.app.flyTo({ ...view, duration: 3000 }) : true;
			const ms = performance.now() - t0;
			b.recording = false;
			return { arrived, ms, frames: b.frames };
		}, target);
		await transfer.idle();
		const shot = join(outDir, `${storm.id}-${name}.png`);
		const exposure = brightness(await page.screenshot({ path: shot }));
		const view = new URL(await page.evaluate(() => globalThis.scintilleBench.app.shareUrl())).searchParams.get('view');
		const paused = frameStats(await record(page, 2000, true));
		await page.evaluate(() => globalThis.scintilleBench.app.clock.play());
		const playing = frameStats(await record(page, seconds * 500));
		const playingCost = frameStats(await record(page, seconds * 500, true));
		const flashes = await page.evaluate(activeFlashes);
		await page.evaluate((time) => {
			const app = globalThis.scintilleBench.app;
			app.clock.pause();
			app.clock.seek(Date.parse(time));
		}, storm.time);
		result.poses[name] = {
			view,
			share: `${base}?storm=${storm.slug}&time=${storm.time}&paused=1&view=${view ?? (target ? viewParam(target) : '')}`,
			flight: { arrived: flight.arrived, ms: Math.round(flight.ms), ...frameStats(flight.frames) },
			transferBytes: transfer.take(),
			paused,
			playing,
			playingCost,
			flashes,
			quality: await page.evaluate(() => document.querySelector('canvas')?.dataset.quality ?? null),
			memory: await page.evaluate(() => globalThis.scintilleBench.memory()),
			screenshot: shot,
			exposure: await exposure,
		};
		process.stdout.write(`${storm.id} ${name}: interval p95 ${playing.intervalP95Ms} ms, cost p50 ${playingCost.workP50Ms} p95 ${playingCost.workP95Ms} ms, ${flashes.active} active flashes\n`);
	}
	await context.close();
	return result;
}

await mkdir(values.out, { recursive: true });
const browser = await chromium.launch({
	channel: 'chromium',
	...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
	headless: !values.headed,
	args: GL_ARGS[values.gl],
});
const results = [];
try {
	for (const storm of storms) results.push(await benchStorm(browser, storm, values.out));
} finally {
	await browser.close();
}
const report = {
	measuredAt: new Date().toISOString(),
	url: base,
	profile: values.profile,
	afterglow: values.afterglow ?? 'per storm',
	clouds: values.clouds,
	gl: values.gl,
	headed: values.headed,
	platform: `${process.platform} ${process.arch}`,
	results,
};
await writeFile(join(values.out, `bench-${values.profile}.json`), `${JSON.stringify(report, null, '\t')}\n`);
process.stdout.write(`wrote ${join(values.out, `bench-${values.profile}.json`)}\n`);
