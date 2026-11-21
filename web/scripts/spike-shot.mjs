// Spike: headless stills of the wind looks. node scripts/spike-shot.mjs --base http://127.0.0.1:4915 --out <dir> --shots name:wind:view[;...]
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

/* global window, requestAnimationFrame */

const { values: o } = parseArgs({
	options: {
		base: { type: 'string', default: 'http://127.0.0.1:4915' },
		out: { type: 'string' },
		shots: { type: 'string' },
		settle: { type: 'string', default: '14' },
		frames: { type: 'string', default: '1' },
		gap: { type: 'string', default: '500' },
		width: { type: 'string', default: '1600' },
		height: { type: 'string', default: '1000' },
		extra: { type: 'string', default: '' },
		fps: { type: 'boolean', default: false },
	},
});
await mkdir(o.out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu'] });
const context = await browser.newContext({ viewport: { width: Number(o.width), height: Number(o.height) }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
	window.__app = null;
	window.addEventListener('globe:ready', (e) => {
		window.__app = e.detail;
	});
});
for (const shot of o.shots.split(';')) {
	const [name, wind, view, extra = ''] = shot.split(':');
	const page = await context.newPage();
	page.on('console', (m) => {
		if (/Shader Error|ERROR: 0:|THREE\./.test(m.text())) console.error(name, m.text().slice(0, 600));
	});
	page.on('pageerror', (e) => console.error(name, e.message));
	const url = new URL('/', o.base);
	if (wind !== 'off') url.searchParams.set('wind', wind);
	for (const pair of `${o.extra}&${extra}`.split('&').filter(Boolean)) url.searchParams.set(...pair.split('='));
	await page.goto(url.href);
	await page.waitForFunction(() => window.__app, null, { timeout: 120_000 }).catch(() => console.error(name, 'ready timeout'));
	const [lat, lon, altitude, tilt = 0, heading = 0] = view.split(',').map(Number);
	await page.evaluate((to) => window.__app.flyTo(to), { lat, lon, altitude, tilt, heading });
	await page.waitForTimeout(Number(o.settle) * 1000);
	if (o.fps) {
		const ms = await page.evaluate(() => new Promise((resolve) => {
			const times = [];
			const tick = (t) => {
				times.push(t);
				if (t - times[0] < 6000) requestAnimationFrame(tick);
				else resolve((t - times[0]) / (times.length - 1));
			};
			requestAnimationFrame(tick);
		}));
		console.log(name, 'frame ms', ms.toFixed(2));
	}
	for (let i = 0; i < Number(o.frames); i++) {
		const file = join(o.out, `${name}${Number(o.frames) > 1 ? `-${i}` : ''}.png`);
		await page.screenshot({ path: file });
		console.log(file);
		if (i + 1 < Number(o.frames)) await page.waitForTimeout(Number(o.gap));
	}
	await page.close();
}
await browser.close();
