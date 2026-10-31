// Captures a storm replay on a running site with the GPU: a few frames while it plays, with brightness metrics.
// Usage (from web/, against a dev server on production data or a deployment):
//   node scripts/capture.mjs --base http://localhost:4321 --storm 2026-10-27-basse-kotto --time 2026-10-27T12:00:00Z \
//     --out <dir> [--prefix <name>] [--speed 60] [--view lat,lon,altitudeKm,tilt[,heading]] [--frames 4] [--gap 700]
//     [--settle 12] [--play-before 1500] [--paused] [--width 1600] [--height 1000] [--profile desktop|mobile]
//     [--afterglow 0] [--quality low|medium|high] [--step <ms> [--at <ISO>]] [--stats] [--no-clouds] [--reduced-motion]
// Without --view the app frames the whole storm itself. A view with a negative latitude needs `--view=-7.4,...`.
// --stats adds `window.__app.lightning.stats` to each frame; --no-clouds hides the cloud layer, so day metrics measure the
// lightning alone; --reduced-motion emulates `prefers-reduced-motion`; --profile mobile emulates an iPhone 15.
// --step freezes the page's wall clock after --play-before and moves it by exactly that many ms per frame, so frames are
// that far apart in wall time whatever a screenshot costs (the leader frames, 50 ms apart); --gap is then unused. With
// --at, frame 0 shows that scene time (ahead of the clock after --play-before), so a given flash can be followed.
// Prints one JSON line per frame and writes <prefix>.json next to the PNGs. Metrics are taken on the central 84 % x 76 %
// of the frame, away from the HUD: white, the share of pixels with every channel over 235; lit, the share with a luminance
// over 90; blobs, the lit 8 x 8 blocks.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, devices } from 'playwright';
import sharp from 'sharp';

/* global window, localStorage, requestAnimationFrame */

const { values: o } = parseArgs({
	options: {
		base: { type: 'string', default: 'http://localhost:4321' },
		storm: { type: 'string' },
		time: { type: 'string' },
		speed: { type: 'string', default: '60' },
		view: { type: 'string' },
		out: { type: 'string' },
		prefix: { type: 'string', default: 'capture' },
		frames: { type: 'string', default: '4' },
		gap: { type: 'string', default: '700' },
		settle: { type: 'string', default: '12' },
		width: { type: 'string', default: '1600' },
		height: { type: 'string', default: '1000' },
		profile: { type: 'string', default: 'desktop' },
		afterglow: { type: 'string', default: '0' },
		quality: { type: 'string' },
		paused: { type: 'boolean', default: false },
		'play-before': { type: 'string', default: '1500' },
		step: { type: 'string' },
		at: { type: 'string' },
		stats: { type: 'boolean', default: false },
		'no-clouds': { type: 'boolean', default: false },
		'reduced-motion': { type: 'boolean', default: false },
	},
});
if (!o.storm || !o.time || !o.out) {
	process.stderr.write('usage: node scripts/capture.mjs --storm <slug> --time <ISO> --out <dir> [options]\n');
	process.exit(2);
}
const PROFILES = {
	desktop: { viewport: { width: Number(o.width), height: Number(o.height) }, deviceScaleFactor: 1 },
	mobile: Object.fromEntries(Object.entries(devices['iPhone 15']).filter(([key]) => key !== 'defaultBrowserType')),
};
if (!(o.profile in PROFILES)) throw new Error(`--profile must be one of ${Object.keys(PROFILES).join(', ')}`);

await mkdir(o.out, { recursive: true });
const url = new URL('/', o.base);
url.searchParams.set('storm', o.storm);
url.searchParams.set('time', o.time);
url.searchParams.set('speed', o.speed);
url.searchParams.set('paused', '1');
if (o.view) url.searchParams.set('view', o.view);
if (o.quality) url.searchParams.set('quality', o.quality);

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const context = await browser.newContext(PROFILES[o.profile]);
await context.addInitScript(({ afterglow, clouds }) => {
	try {
		localStorage.setItem('scintille.display.minutes', afterglow);
		localStorage.setItem('scintille.clouds.visible', clouds);
	} catch {
		/* private mode */
	}
	const realNow = Date.now.bind(Date);
	window.__frozen = null;
	Date.now = () => window.__frozen ?? realNow();
	window.__realNow = realNow;
	window.__app = null;
	window.addEventListener('globe:ready', (e) => {
		window.__app = e.detail;
	});
}, { afterglow: o.afterglow, clouds: o['no-clouds'] ? '0' : '1' });
const page = await context.newPage();
if (o['reduced-motion']) await page.emulateMedia({ reducedMotion: 'reduce' });
const errors = [];
page.on('console', (m) => {
	if (/Shader Error|ERROR: 0:|THREE\./.test(m.text())) errors.push(m.text().split('\n').filter((l) => /ERROR|THREE/.test(l)).join(' ').slice(0, 300));
});
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url.href);
await page
	.waitForFunction(() => window.__app && window.__app.replay?.state?.selected && !window.__app.replay.state.loading, null, { timeout: 180_000 })
	.catch(() => errors.push('ready timeout'));
await page.waitForTimeout(Number(o.settle) * 1000);

/** Flashes started within the last wall second of scene time, the clock, the view and the lightning stats. */
const state = () =>
	page.evaluate((withStats) => {
		const app = window.__app;
		const ring = app.debug.ring;
		const now = app.clock.time();
		const span = 1000 * (app.clock.mode === 'replay' ? app.clock.speed : 1);
		let flashes = 0;
		for (let i = 0; i < ring.size; i++) {
			const dt = now - ring.time[ring.slot(i)];
			if (dt >= 0 && dt <= span) flashes++;
		}
		const out = { flashes, time: new Date(now).toISOString(), view: new URL(app.shareUrl()).searchParams.get('view'), speed: app.clock.speed };
		out.quality = app.debug?.quality?.() ?? null;
		if (withStats) out.stats = app.lightning?.stats ? JSON.parse(JSON.stringify(app.lightning.stats)) : null;
		return out;
	}, o.stats);

async function metrics(file) {
	const image = sharp(file);
	const { width, height } = await image.metadata();
	const w = Math.round(width * 0.84);
	const h = Math.round(height * 0.76);
	const buf = await image.extract({ left: Math.round(width * 0.08), top: Math.round(height * 0.12), width: w, height: h }).removeAlpha().raw().toBuffer();
	let white = 0;
	let lit = 0;
	const blocks = new Set();
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			const [r, g, b] = [buf[i], buf[i + 1], buf[i + 2]];
			if (r > 235 && g > 235 && b > 235) white++;
			if (0.2126 * r + 0.7152 * g + 0.0722 * b > 90) {
				lit++;
				blocks.add(((y >> 3) << 16) | (x >> 3));
			}
		}
	}
	const n = w * h;
	return { white: +((white / n) * 100).toFixed(2), lit: +((lit / n) * 100).toFixed(2), blobs: blocks.size };
}

const results = [];
if (!o.paused) {
	await page.evaluate(() => window.__app.clock.play());
	await page.waitForTimeout(Number(o['play-before']));
}
const step = o.step === undefined ? null : Number(o.step);
const frozenFrom =
	step === null
		? null
		: await page.evaluate((at) => {
				const now = window.__realNow();
				const clock = window.__app.clock;
				return (window.__frozen = at === null ? now : now + (Date.parse(at) - clock.time()) / clock.speed);
			}, o.at ?? null);
for (let k = 0; k < Number(o.frames); k++) {
	const file = join(o.out, `${o.prefix}-${k}.png`);
	if (step !== null) {
		await page.evaluate((wall) => {
			window.__frozen = wall;
			return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		}, frozenFrom + k * step);
	}
	const now = await state();
	await page.screenshot({ path: file });
	const row = { file, ...now, ...(await metrics(file)) };
	results.push(row);
	process.stdout.write(`${JSON.stringify(row)}\n`);
	if (step === null && k + 1 < Number(o.frames)) await page.waitForTimeout(Number(o.gap));
}
if (errors.length) process.stdout.write(`ERRORS: ${[...new Set(errors)].join(' | ')}\n`);
await writeFile(join(o.out, `${o.prefix}.json`), JSON.stringify({ url: url.href, profile: o.profile, results, errors: [...new Set(errors)] }, null, 2));
await browser.close();
