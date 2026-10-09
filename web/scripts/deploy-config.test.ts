import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { objectHeaders, plan } from './r2-upload.mjs';

interface R2Binding {
	binding: string;
	bucket_name: string;
}

const raw = readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as {
	r2_buckets: R2Binding[];
	previews: { r2_buckets: R2Binding[] };
	assets: { run_worker_first: boolean };
	cache: { enabled: boolean };
	routes: { pattern: string; custom_domain: boolean }[];
};

describe('wrangler.jsonc', () => {
	it('binds production to scintille-live', () => {
		expect(config.r2_buckets).toEqual([{ binding: 'LIVE', bucket_name: 'scintille-live' }]);
		expect(config.routes).toEqual([{ pattern: 'scintille.app', custom_domain: true }]);
	});

	it('never binds a Preview to production data', () => {
		expect(config.previews.r2_buckets).toEqual([{ binding: 'LIVE', bucket_name: 'scintille-live-preview' }]);
		expect(JSON.stringify(config.previews)).not.toMatch(/"scintille-live"/);
	});

	it('keeps static assets in front of the Worker and Workers Cache off', () => {
		expect(config.assets.run_worker_first).toBe(false);
		expect(config.cache.enabled).toBe(false);
	});
});

describe('r2-upload', () => {
	it('sets the live feed contract headers', () => {
		expect(objectHeaders('live/manifest.json')?.cache).toBe('public, max-age=10');
		expect(objectHeaders('live/chunks/20260715T180000Z.bin.gz')?.cache).toBe('public, max-age=31536000, immutable');
		expect(objectHeaders('README.md')).toBeUndefined();
	});

	it('groups files by headers under a prefix', () => {
		const groups = plan(['/o/4k/day.webp', '/o/4k/day.ktx2', '/o/2k/mask.webp', '/o/notes.txt'], '/o', 'textures/v1');
		expect(groups.map((g) => g.entries.map((e: { key: string }) => e.key))).toEqual([
			['textures/v1/4k/day.webp', 'textures/v1/2k/mask.webp'],
			['textures/v1/4k/day.ktx2'],
		]);
	});
});
