// Serves a local build for the #125 measurements: the site from dist/client, textures from the
// local pyramid, everything else proxied to data.scintille.app with CORS opened to localhost.
// Usage: node spike/surface/serve.mjs [--port 4400] [--textures <dir>]
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import https from 'node:https';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';

const WEB = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({
	options: {
		port: { type: 'string', default: '4400' },
		site: { type: 'string', default: join(WEB, 'dist', 'client') },
		textures: { type: 'string', default: join(WEB, 'scripts', 'textures', 'out') },
		upstream: { type: 'string', default: 'https://data.scintille.app' },
	},
});
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain', '.xml': 'application/xml' };

async function file(res, path) {
	const info = await stat(path).catch(() => null);
	if (!info) return false;
	if (info.isDirectory()) return file(res, join(path, 'index.html'));
	res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-length': info.size, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
	createReadStream(path).pipe(res);
	return true;
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const path = normalize(decodeURIComponent(url.pathname));
	if (path.startsWith('/textures/') && (await file(res, join(values.textures, path.slice('/textures/'.length))))) return;
	if (path.startsWith('/data/')) {
		const target = new URL(`${values.upstream}${path.slice('/data'.length)}${url.search}`);
		const headers = { host: target.host };
		for (const name of ['accept', 'accept-encoding', 'range', 'if-none-match', 'if-modified-since']) {
			if (req.headers[name]) headers[name] = req.headers[name];
		}
		https.get(target, { headers }, (upstream) => {
			res.writeHead(upstream.statusCode ?? 502, { ...upstream.headers, 'access-control-allow-origin': '*' });
			upstream.pipe(res);
		}).on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
		return;
	}
	if (await file(res, join(values.site, path))) return;
	res.writeHead(404).end();
}).listen(Number(values.port), () => process.stdout.write(`http://localhost:${values.port}/\n`));
