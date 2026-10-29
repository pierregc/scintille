// Drives the surface tiles through rapid navigation, missing tiles, throttling and an offline spell
// on a build served by serve.mjs, and checks that the globe stays whole and the cache bounded.
// Usage: node spike/surface/stress.mjs [--url http://localhost:4400] [--profile desktop|mobile] [--out <dir>]
//   [--storm <slug> --time <iso>]: replay paused on a storm, so the sun stays put (R2 by default).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, devices } from 'playwright';
import sharp from 'sharp';

const { values } = parseArgs({
	options: {
		url: { type: 'string', default: 'http://localhost:4400' },
		profile: { type: 'string', default: 'desktop' },
		out: { type: 'string', default: 'bench/stress' },
		storm: { type: 'string', default: '2026-10-18-mato-grosso-22' },
		time: { type: 'string', default: '2026-10-18T19:15:00Z' },
	},
});
const PROFILES = {
	desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 },
	mobile: Object.fromEntries(Object.entries(devices['iPhone 15']).filter(([key]) => key !== 'defaultBrowserType')),
};

/* global window, performance */
const PLACES = [
	{ lat: -6.77, lon: -59.48 },
	{ lat: 7.06, lon: 13.7 },
	{ lat: 41.5, lon: 2.5 },
	{ lat: 29.5, lon: -90.5 },
	{ lat: -33.9, lon: 151.2 },
	{ lat: 35.7, lon: 139.7 },
	{ lat: 64.1, lon: -21.9 },
	{ lat: -1.3, lon: 36.8 },
];

await mkdir(values.out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--ignore-gpu-blocklist', '--enable-gpu', '--js-flags=--expose-gc'] });
const context = await browser.newContext(PROFILES[values.profile]);
await context.addInitScript(() => {
	window.addEventListener('globe:ready', (event) => { window.__app = event.detail; });
});
const page = await context.newPage();
page.setDefaultTimeout(120_000);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

const hits = new Map();
const notFound = new Map();
let mode = 'pass';
await context.route('**/textures/surface/**/*.webp', async (route) => {
	const path = new URL(route.request().url()).pathname;
	hits.set(path, (hits.get(path) ?? 0) + 1);
	if (mode === 'missing' && /\/day\/5\//.test(path)) {
		notFound.set(path, (notFound.get(path) ?? 0) + 1);
		return route.fulfill({ status: 404, body: '' });
	}
	if (mode === 'throttled') return route.fulfill({ status: 429, headers: { 'retry-after': '3' }, body: '' });
	return route.continue();
});
const requests = () => [...hits.values()].reduce((a, b) => a + b, 0);

const stats = () => page.evaluate(() => window.__app.surface.stats().tiles);
const heap = () => page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
const fly = (place, altitude, duration, tilt = 1) => page.evaluate(([p, a, d, t]) => window.__app.flyTo({ ...p, altitude: a, duration: d, tilt: t }), [place, altitude, duration, tilt]);
const settle = async (ms = 1500, timeoutMs = 60_000) => {
	const deadline = Date.now() + timeoutMs;
	let quiet = 0;
	while (Date.now() < deadline) {
		const s = await stats();
		quiet = s.loading === 0 && s.queued === 0 ? quiet + 100 : 0;
		if (quiet >= ms) return s;
		await delay(100);
	}
	return stats();
};
/** The globe is whole when the Earth is drawn and the frame is not empty at the centre. */
const whole = async (name) => {
	const png = await page.screenshot({ path: join(values.out, `${values.profile}-${name}.png`) });
	const { data } = await sharp(png).resize({ width: 320 }).extract({ left: 80, top: 30, width: 160, height: 60 }).greyscale().raw().toBuffer({ resolveWithObject: true });
	const mean = data.reduce((a, b) => a + b, 0) / data.length;
	const detail = await page.evaluate(() => window.__app.surface.tiles.uniforms.surfaceOn.value > 0);
	return { detail, mean: Math.round(mean) };
};

await page.goto(`${values.url}/?storm=${values.storm}&time=${values.time}&paused=1&surface=tiles`);
await page.waitForFunction(() => window.__app?.surface?.stats().tiles && !window.__app.replay.state.loading);
const report = { url: values.url, profile: values.profile, steps: {} };
const step = async (name, extra = {}) => {
	const s = await stats();
	report.steps[name] = { ...extra, whole: await whole(name), heap: await heap(), requests: requests(), stats: s };
	process.stdout.write(`${name}: ${JSON.stringify({ ...extra, textures: s.textures, bytes: s.bytes, deepest: s.deepest, requested: s.requested, aborted: s.aborted, unused: s.unused, failed: s.failed, missing: s.missing, layers: s.layers, uploaded: s.uploaded })}\n`);
};

await fly(PLACES[0], 400, 3000);
await settle();
await step('dive');

let before = requests();
for (let i = 0; i < 40; i++) {
	const place = PLACES[(i * 3) % PLACES.length];
	void fly({ lat: place.lat + (i % 5), lon: place.lon - (i % 7) }, 400 + (i % 4) * 300, 250 + (i % 3) * 150, 1 + (i % 3) * 30);
	await delay(120 + (i % 4) * 60);
}
await fly(PLACES[1], 400, 1500);
const rapid = requests() - before;
await settle();
await step('rapid', { requestsDuringRapid: rapid });

const heaps = [];
for (let round = 0; round < 3; round++) {
	for (const place of PLACES) {
		await fly(place, 400, 1500);
		await settle(800);
		await fly(place, 740, 800, 60);
		await settle(800);
		await fly(place, 20_000, 1500);
	}
	await page.evaluate(() => globalThis.gc?.());
	heaps.push(await heap());
	await step(`round${round + 1}`);
}
report.heaps = heaps;
process.stdout.write(`heap after each round: ${heaps.map((h) => (h / 1e6).toFixed(1)).join(', ')} MB\n`);

mode = 'missing';
await fly({ lat: -12.5, lon: -55.5 }, 400, 3000);
await settle();
await delay(5000);
await step('missing', { notFound: notFound.size, notFoundTwice: [...notFound.values()].filter((n) => n > 1).length });
mode = 'pass';

mode = 'throttled';
before = requests();
await fly({ lat: 40.4, lon: -3.7 }, 400, 3000);
await delay(2500);
const throttledRequests = requests() - before;
mode = 'pass';
await settle(1500, 30_000);
await step('throttled', { requestsWhileThrottled: throttledRequests });

await context.setOffline(true);
before = requests();
await fly({ lat: 48.85, lon: 2.35 }, 400, 3000);
await delay(8000);
await step('offline', { attempts: requests() - before });
await context.setOffline(false);
const back = Date.now();
await settle(1500, 90_000);
await step('online', { recoveredMs: Date.now() - back });

report.errors = errors;
await writeFile(join(values.out, `stress-${values.profile}.json`), `${JSON.stringify(report, null, '\t')}\n`);
process.stdout.write(`errors: ${errors.length}\n`);
await browser.close();
