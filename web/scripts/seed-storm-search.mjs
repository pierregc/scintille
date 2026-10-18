// Seed only the local Worker R2 binding; this script has no remote upload path.
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative, join } from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node scripts/seed-storm-search.mjs /tmp/search-fixture');
const require = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const runtime = new Miniflare(convertV4MiniflareOptions({
	modules: true,
	script: 'export default { fetch() { return new Response("Local fixture seeding"); } }',
	r2Buckets: { LIVE: 'scintille-live' },
	resourcePersistencePath: resolve('.wrangler/state/v3'),
}));
try {
	const bucket = await runtime.getR2Bucket('LIVE');
	let count = 0;
	async function seed(path) {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const file = join(path, entry.name);
			if (entry.isDirectory()) await seed(file);
			else { await bucket.put(relative(directory, file), await readFile(file)); count++; }
		}
	}
	await seed(join(directory, 'storms'));
	console.log(`Seeded ${count} synthetic search objects in local scintille-live.`);
} finally { await runtime.dispose(); }
