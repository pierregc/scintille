// Uploads repository files to R2 with Wrangler. See docs/deploy.md.
// Usage: node scripts/r2-upload.mjs fixtures --local | fixtures --preview | textures
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const WEB = join(import.meta.dirname, '..');
const FIXTURES = join(WEB, '..', 'fixtures');
const TEXTURES = join(WEB, 'scripts', 'textures', 'out');
export const TEXTURES_PREFIX = 'textures/v1';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Content type and Cache-Control per file, matching the live feed contract. */
export function objectHeaders(key) {
	if (key.endsWith('manifest.json')) return { type: 'application/json', cache: 'public, max-age=10' };
	if (key.endsWith('.json')) return { type: 'application/json', cache: 'public, max-age=60' };
	if (key.endsWith('.bin.gz')) return { type: 'application/octet-stream', cache: IMMUTABLE };
	if (key.endsWith('.webp')) return { type: 'image/webp', cache: IMMUTABLE };
	if (key.endsWith('.ktx2')) return { type: 'image/ktx2', cache: IMMUTABLE };
	return undefined;
}

async function files(dir) {
	const entries = await readdir(dir, { withFileTypes: true, recursive: true });
	return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** Groups files by headers, since `wrangler r2 bulk put` sets one set of headers per call. */
export function plan(paths, root, prefix = '') {
	const groups = new Map();
	for (const file of paths) {
		const key = [prefix, relative(root, file).split(sep).join('/')].filter(Boolean).join('/');
		const headers = objectHeaders(key);
		if (!headers) continue;
		const id = `${headers.type}|${headers.cache}`;
		if (!groups.has(id)) groups.set(id, { ...headers, entries: [] });
		groups.get(id).entries.push({ key, file });
	}
	return [...groups.values()];
}

async function upload(bucket, groups, location) {
	const dir = await mkdtemp(join(tmpdir(), 'scintille-r2-'));
	try {
		for (const [i, group] of groups.entries()) {
			const list = join(dir, `${i}.json`);
			await writeFile(list, JSON.stringify(group.entries));
			const args = ['r2', 'bulk', 'put', bucket, '--filename', list, location];
			args.push('--content-type', group.type, '--cache-control', group.cache);
			console.log(`${bucket}: ${group.entries.length} objects (${group.type})`);
			const run = spawnSync('wrangler', args, { cwd: WEB, stdio: 'inherit', shell: false });
			if (run.status !== 0) throw new Error(`wrangler exited with ${run.status ?? run.signal}`);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function main([what, flag]) {
	if (what === 'fixtures' && (flag === '--local' || flag === '--preview')) {
		const groups = plan(await files(FIXTURES), FIXTURES);
		const bucket = flag === '--local' ? 'scintille-live' : 'scintille-live-preview';
		return upload(bucket, groups, flag === '--local' ? '--local' : '--remote');
	}
	if (what === 'textures' && flag === undefined) {
		const groups = plan(await files(TEXTURES), TEXTURES, TEXTURES_PREFIX);
		if (groups.length === 0) throw new Error(`no textures in ${TEXTURES}, run pnpm -C web textures first`);
		return upload('scintille-live', groups, '--remote');
	}
	throw new Error('usage: r2-upload.mjs fixtures --local | fixtures --preview | textures');
}

if (process.argv[1] === import.meta.filename) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
