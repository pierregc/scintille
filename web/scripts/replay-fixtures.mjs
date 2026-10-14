// @ts-check
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { buildInfo } from './build-info.mjs';

/** @returns {import('astro').AstroIntegration} */
export function replayFixtures() {
	return {
		name: 'scintille-replay-fixtures',
		hooks: {
			'astro:build:done': async ({ dir }) => {
				if (buildInfo().pr === null) return;
				const root = fileURLToPath(new URL('../../fixtures/', import.meta.url));
				const metadataPath = 'storms/2026-07-15-orlando.json';
				/** @type {import('../src/contract/types').StormDetail} */
				const metadata = JSON.parse(await readFile(join(root, metadataPath), 'utf8'));
				for (const path of [metadataPath, ...metadata.replay.chunks.map((chunk) => chunk.path)]) {
					const target = join(fileURLToPath(dir), '_replay-fixtures', path);
					await mkdir(dirname(target), { recursive: true });
					await copyFile(join(root, path), target);
				}
			},
		},
	};
}
