// @ts-check
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { placeKeys, PLACES_PATH } from '../src/search/places.ts';

const SOURCE = new URL('../../data/packages/scintille-pipelines/src/scintille_pipelines/geodata/places.tsv.gz', import.meta.url);

/** Static place files keyed by word prefix, from the GeoNames places of the storm names. */
export async function placeFiles() {
	const [header, ...lines] = gunzipSync(await readFile(SOURCE)).toString('utf8').trim().split('\n');
	if (header !== 'name\tlat\tlon\tcountry\tregion\tpopulation') throw new Error(`unexpected places header: ${header}`);
	/** @type {Map<string, import('../src/search/places.ts').Place[]>} */
	const files = new Map();
	for (const line of lines) {
		const [name, lat, lon, country, region, population] = line.split('\t');
		/** @type {import('../src/search/places.ts').Place} */
		const place = [name, region, country, Number(lat), Number(lon), Number(population)];
		for (const key of placeKeys(name)) files.set(key, [...(files.get(key) ?? []), place]);
	}
	return new Map([...files].sort(([a], [b]) => a.localeCompare(b)).map(([key, places]) => [
		`${PLACES_PATH.slice(1)}${key}.json`,
		JSON.stringify(places.sort((a, b) => b[5] - a[5] || a[0].localeCompare(b[0]))),
	]));
}

/** @returns {import('astro').AstroIntegration} */
export function places() {
	return {
		name: 'scintille-places',
		hooks: {
			'astro:server:setup': async ({ server }) => {
				const files = await placeFiles();
				server.middlewares.use((request, response, next) => {
					const body = files.get((request.url ?? '').split('?')[0].slice(1));
					if (body === undefined) return next();
					response.setHeader('Content-Type', 'application/json');
					response.end(body);
				});
			},
			'astro:build:done': async ({ dir, logger }) => {
				const files = await placeFiles();
				let bytes = 0;
				for (const [path, body] of files) {
					const target = join(fileURLToPath(dir), path);
					await mkdir(join(target, '..'), { recursive: true });
					await writeFile(target, body);
					bytes += body.length;
				}
				logger.info(`${files.size} place files, ${(bytes / 1e6).toFixed(1)} MB`);
			},
		},
	};
}
