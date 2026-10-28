// Uploads repository files to R2 with Wrangler. See docs/deploy.md.
// Usage: node scripts/r2-upload.mjs fixtures --local | fixtures --preview | textures | surface
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { SURFACE_VERSION } from './textures/surface.mjs';

const WEB = join(import.meta.dirname, '..');
const FIXTURES = join(WEB, '..', 'fixtures');
const TEXTURES = join(WEB, 'scripts', 'textures', 'out');
export const TEXTURES_PREFIX = 'textures/v2';
export const SURFACE = join(TEXTURES, 'surface');
export const SURFACE_PREFIX = `textures/v${SURFACE_VERSION}`;
const PUBLIC = 'https://data.scintille.app';

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

/** Surface tiles first, then their manifest alone, so a published manifest never lists a missing tile. */
export function surfacePlan(paths) {
	const tiles = plan(paths.filter((p) => p.endsWith('.webp')), SURFACE, SURFACE_PREFIX);
	const manifest = plan(paths.filter((p) => relative(SURFACE, p) === 'manifest.json'), SURFACE, SURFACE_PREFIX);
	if (tiles.length !== 1 || manifest.length !== 1) throw new Error(`no surface pyramid in ${SURFACE}, run node scripts/textures/tiles.mjs first`);
	return [...tiles, ...manifest];
}

/** The local pyramid must have passed its check, and a published one under the same version must be the same build. */
async function assertSurfaceReady() {
	const manifest = JSON.parse(await readFile(join(SURFACE, 'manifest.json'), 'utf8'));
	const check = JSON.parse(await readFile(join(TEXTURES, 'surface-check.json'), 'utf8').catch(() => '{}'));
	if (check.digest !== manifest.digest || check.failures?.length !== 0) {
		throw new Error('run node scripts/textures/check-tiles.mjs and fix its failures first');
	}
	const res = await fetch(`${PUBLIC}/${SURFACE_PREFIX}/manifest.json`);
	if (res.status === 404) return true;
	if (!res.ok) throw new Error(`published manifest: ${res.status}`);
	const published = await res.json();
	if (published.digest !== manifest.digest) {
		throw new Error(`${SURFACE_PREFIX} holds another build (${published.digest.slice(0, 12)}): bump SURFACE_VERSION in scripts/textures/surface.mjs`);
	}
	console.log(`${SURFACE_PREFIX}: build ${manifest.digest.slice(0, 12)} already published`);
	return false;
}

/** Objects already published, read through the public domain: R2's own API has no listing in Wrangler. */
async function unpublished(entries) {
	const left = [];
	let next = 0;
	await Promise.all(Array.from({ length: 16 }, async () => {
		while (next < entries.length) {
			const entry = entries[next++];
			const res = await fetch(`${PUBLIC}/${entry.key}`, { method: 'HEAD' });
			if (!res.ok) left.push(entry);
		}
	}));
	return left;
}

/**
 * One `wrangler r2 bulk put` per group of headers. With `resume`, a failed group (rate limit, gateway
 * timeout) waits, then sends only what is not published yet.
 */
async function upload(bucket, groups, location, { resume = false, attempts = 3 } = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'scintille-r2-'));
	try {
		for (const [i, group] of groups.entries()) {
			const list = join(dir, `${i}.json`);
			for (let attempt = 1; ; attempt++) {
				const entries = resume ? await unpublished(group.entries) : group.entries;
				if (entries.length === 0) break;
				await writeFile(list, JSON.stringify(entries));
				const args = ['r2', 'bulk', 'put', bucket, '--filename', list, location, '--concurrency', resume ? '4' : '20'];
				args.push('--content-type', group.type, '--cache-control', group.cache);
				console.log(`${bucket}: ${entries.length} objects (${group.type})`);
				const run = spawnSync('wrangler', args, { cwd: WEB, stdio: 'inherit', shell: false });
				if (run.status === 0) break;
				if (attempt === attempts) throw new Error(`wrangler exited with ${run.status ?? run.signal}`);
				console.warn(`${bucket}: wrangler exited with ${run.status ?? run.signal}, retrying in a minute`);
				await sleep(60_000);
			}
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
		const groups = plan((await files(TEXTURES)).filter((p) => !relative(TEXTURES, p).startsWith('surface')), TEXTURES, TEXTURES_PREFIX);
		if (groups.length === 0) throw new Error(`no textures in ${TEXTURES}, run pnpm -C web textures first`);
		return upload('scintille-live', groups, '--remote');
	}
	if (what === 'surface' && flag === undefined) {
		const groups = surfacePlan(await files(SURFACE));
		if (!(await assertSurfaceReady())) return;
		const [tiles, manifest] = groups;
		await upload('scintille-live', [tiles], '--remote', { resume: true, attempts: 30 });
		return upload('scintille-live', [manifest], '--remote');
	}
	throw new Error('usage: r2-upload.mjs fixtures --local | fixtures --preview | textures | surface');
}

if (process.argv[1] === import.meta.filename) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
