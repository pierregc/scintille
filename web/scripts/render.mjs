// Exports PNG frames of the globe's render page with headless Chromium.
// Usage: node scripts/render.mjs --start <ISO> --end <ISO> --out <dir> [--url http://localhost:4321]
//   [--frames 30] [--width 1920] [--height 1080] [--lat] [--lon] [--alt <km>] [--tilt] [--quality high]
//   [--gl swiftshader|gpu]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { URL, URLSearchParams } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const PAGE_PARAMS = ['start', 'end', 'frames', 'width', 'height', 'lat', 'lon', 'alt', 'tilt', 'quality'];

const { values } = parseArgs({
	options: {
		url: { type: 'string', default: 'http://localhost:4321' },
		out: { type: 'string' },
		gl: { type: 'string', default: 'swiftshader' },
		timeout: { type: 'string', default: '120000' },
		...Object.fromEntries(PAGE_PARAMS.map((name) => [name, { type: 'string' }])),
	},
});

if (!values.out || !values.start || !values.end) {
	process.stderr.write('usage: node scripts/render.mjs --start <ISO> --end <ISO> --out <dir> [options]\n');
	process.exit(2);
}

const GL_ARGS = {
	swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
	gpu: ['--ignore-gpu-blocklist', '--enable-gpu'],
};
if (!(values.gl in GL_ARGS)) throw new Error(`--gl must be one of ${Object.keys(GL_ARGS).join(', ')}`);

const query = new URLSearchParams();
for (const name of PAGE_PARAMS) if (values[name] !== undefined) query.set(name, values[name]);
const pageUrl = new URL(`render/?${query}`, values.url.endsWith('/') ? values.url : `${values.url}/`);
const timeout = Number(values.timeout);

const started = performance.now();
const browser = await chromium.launch({ channel: 'chromium', args: GL_ARGS[values.gl] });
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	page.setDefaultTimeout(timeout);
	page.on('console', (message) => {
		if (message.type() === 'error') process.stderr.write(`page: ${message.text()}\n`);
	});
	await page.goto(pageUrl.href);
	await page.waitForFunction(() => globalThis.scintilleRender !== undefined);
	await page.evaluate(() => globalThis.scintilleRender.ready);
	const { params, renderer } = await page.evaluate(() => {
		const gl = globalThis.document.createElement('canvas').getContext('webgl2');
		const debug = gl?.getExtension('WEBGL_debug_renderer_info');
		return {
			params: globalThis.scintilleRender.params,
			renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown',
		};
	});
	await page.setViewportSize({ width: params.width, height: params.height });
	process.stdout.write(`${pageUrl.href}\nWebGL renderer: ${renderer}\n`);
	process.stdout.write(`ready in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);

	await mkdir(values.out, { recursive: true });
	const drawStart = performance.now();
	for (let index = 0; index < params.frames; index++) {
		const dataUrl = await page.evaluate((i) => globalThis.scintilleRender.frame(i), index);
		const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
		await writeFile(join(values.out, `frame-${String(index).padStart(5, '0')}.png`), png);
	}
	const seconds = (performance.now() - drawStart) / 1000;
	process.stdout.write(
		`${params.frames} frames ${params.width}x${params.height} in ${seconds.toFixed(1)} s ` +
			`(${((seconds * 1000) / params.frames).toFixed(0)} ms/frame) to ${values.out}\n`,
	);
} finally {
	await browser.close();
}
