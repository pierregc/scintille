/* global process, console, URL, Buffer, bench */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [task = 'shots', outDir = 'dist/spike'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal'] });
try {
	const page = await browser.newPage();
	page.on('console', (m) => console.error('page:', m.text()));
	page.on('pageerror', (e) => console.error('pageerror:', e.message));
	await page.goto(new URL('../dist/spike/index.html', import.meta.url).href);
	await page.waitForFunction(() => globalThis.bench);
	console.log(await page.evaluate(() => ({ gpu: bench.gpu, timer: bench.timer })));

	if (task === 'shots') {
		const views = [
			['far', 20000, 0],
			['near', 800, 0],
			['tilt60', 250, 60],
			['tilt80', 120, 80],
		];
		for (const [name, altitudeKm, tilt] of views) {
			for (const mode of ['flat', 'ribbon']) {
				const c = { mode, active: name === 'far' ? 300 : 25, glowing: name === 'far' ? 3000 : 150, altitudeKm, tilt, width: 960, height: 540 };
				const url = await page.evaluate((c) => bench.shot(c), c);
				writeFileSync(`${outDir}/${name}-${mode}.png`, Buffer.from(url.split(',')[1], 'base64'));
			}
		}

	}

	if (task === 'measure') {
		const rows = [];
		const views = [
			['far nadir', 20000, 0],
			['near nadir', 800, 0],
			['tilt 60', 250, 60],
			['tilt 80', 120, 80],
		];
		const sizes = [
			[1920, 1080],
			[2880, 1800],
		];
		for (const [width, height] of sizes) {
			for (const [view, altitudeKm, tilt] of views) {
				for (const active of [50, 500, 5000]) {
					for (const mode of ['none', 'flat', 'ribbon']) {
						const c = { mode, active, glowing: 20000, altitudeKm, tilt, width, height };
						const r = await page.evaluate((c) => bench.measure(c), c);
						rows.push({ size: `${width}x${height}`, view, active, mode, ...r });
						console.log(JSON.stringify(rows.at(-1)));
					}
				}
			}
		}
		for (const segments of [8, 16, 32]) {
			const c = { mode: 'ribbon', active: 5000, glowing: 0, altitudeKm: 250, tilt: 60, width: 1920, height: 1080, segments };
			const r = await page.evaluate((c) => bench.measure(c), c);
			rows.push({ size: '1920x1080', view: 'tilt 60', active: 5000, mode: `ribbon s${segments}`, ...r });
			console.log(JSON.stringify(rows.at(-1)));
		}
		const cpu = await page.evaluate(() => bench.cpuGenerate(20000, 3, 16));
		console.log('cpu', JSON.stringify(cpu));
		writeFileSync(`${outDir}/measure.json`, JSON.stringify({ rows, cpu }, null, 1));
	}
} finally {
	await browser.close();
}
