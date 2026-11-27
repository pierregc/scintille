// Map mode prototype (#507): measures how far the map drifts from the scene at a set of poses, with captures.
// Usage (from web/, against a dev server on the fixtures): node scripts/map-check.mjs --out <dir> [--base http://localhost:4321]
//   [--map grid|1] [--now <ISO>]; --now is the wall time the page believes, inside the fixture hour by default.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

/* global window, localStorage */

const { values: o } = parseArgs({
	options: {
		base: { type: 'string', default: 'http://localhost:4321' },
		map: { type: 'string', default: 'grid' },
		out: { type: 'string' },
		now: { type: 'string', default: '2026-07-15T18:58:00Z' },
		settle: { type: 'string', default: '1500' },
	},
});
if (!o.out) {
	process.stderr.write('usage: node scripts/map-check.mjs --out <dir> [--map grid|1]\n');
	process.exit(2);
}
const POSES = [
	{ name: 'globe', lat: 28, lon: -81, altitude: 12000 },
	{ name: 'globe-north', lat: 70, lon: 20, altitude: 6000 },
	{ name: '400km', lat: 28.5, lon: -81.4, altitude: 400, tilt: 0.01 },
	{ name: '400km-tilt', lat: 28.5, lon: -81.4, altitude: 400, tilt: 60, heading: 40 },
	{ name: 'floor', lat: 28.5, lon: -81.4, altitude: 30, tilt: 0.01 },
	{ name: 'floor-tilt', lat: 28.5, lon: -81.4, altitude: 30, tilt: 70, heading: 300 },
	{ name: 'floor-80', lat: 28.5, lon: -81.4, altitude: 30, tilt: 80 },
	{ name: 'floor-horizon', lat: 28.5, lon: -81.4, altitude: 30, tilt: 88 },
	{ name: 'lat-84', lat: 84, lon: 0, altitude: 400, tilt: 0.01 },
	{ name: 'pole', lat: 89, lon: 0, altitude: 400, tilt: 0.01 },
];

await mkdir(o.out, { recursive: true });
const browser = await chromium.launch({
	channel: 'chromium',
	...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') process.stderr.write(`${message.text()}\n`); });
await page.addInitScript(() => { try { localStorage.setItem('scintille.display.minutes', '30'); } catch { /* storage off */ } });
await page.addInitScript((now) => {
	const shift = Date.parse(now) - Date.now();
	const real = Date.now.bind(Date);
	Date.now = () => real() + shift;
}, o.now);
await page.addInitScript(() => window.addEventListener('globe:ready', (event) => { window.__app = event.detail; }));
await page.goto(`${o.base}/?map=${o.map}&quality=medium`);
await page.waitForFunction(() => typeof window.__app?.map?.mismatch() === 'number', null, { timeout: 60000 });
for (const pose of POSES) {
	await page.evaluate((view) => window.__app.map.place(view), pose);
	await page.waitForTimeout(Number(o.settle));
	const result = await page.evaluate(() => ({ mismatchPx: window.__app.map.mismatch(), shown: window.__app.map.shown(), view: window.__app.map.view() }));
	await page.screenshot({ path: join(o.out, `${pose.name}.png`) });
	process.stdout.write(`${JSON.stringify({ pose: pose.name, ...result })}\n`);
}
await browser.close();
