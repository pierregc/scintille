import { describe, expect, it } from 'vitest';
import { framingFixtures } from '../../../scripts/framing-fixtures';
import { stormSource } from '../archive/storm';
import { parseCatalogPage } from './catalog';
import { frameStorm } from './framing';
import cases from './framing-cases.json';
import { trackGeometry } from './track';
import { decodeChunk, CHUNK_SCALES } from '../live/decode';
import { gunzipSync } from 'node:zlib';

it('keeps five explicitly synthetic reproducible cases with desktop and portrait poses', () => {
	expect(cases).toHaveLength(5);
	for (const item of cases) {
		for (const aspect of [16 / 9, 9 / 16]) {
			const view = frameStorm(item.bounds, 35, aspect);
			expect(view.duration).toBeLessThan(4000);
			expect(view.tilt).toBeLessThanOrEqual(12);
			expect(view.altitude).toBeGreaterThanOrEqual(300);
		}
	}
});

describe('Preview calibration extracts', () => {
	it('uses the production loader and contains flashes along the declared track', async () => {
		const files = framingFixtures();
		const fetchFn: typeof fetch = async (input) => {
			const body = files.get(new URL(String(input)).pathname.slice(1));
			return body ? new Response(new Uint8Array(body)) : new Response('', { status: 404 });
		};
		for (const item of cases.slice(1)) {
			const { detail, source } = await stormSource('https://fixture.test/', item.slug, new AbortController().signal, fetchFn);
			const chunks = await source.load(new AbortController().signal);
			expect(chunks[0].count).toBe(detail.replay.flash_count);
			expect(detail.storm.level_rule).toBe('synthetic-fixture-only');
			expect(detail.storm.label).toContain('Synthetic');
			const geometry = trackGeometry(detail.track, 1);
			expect(geometry.times).toHaveLength(4);
			const file = files.get(detail.replay.chunks[0].path);
			if (!file) throw new Error('missing fixture');
			const raw = new Uint8Array(gunzipSync(file));
			const decoded = decodeChunk(raw.buffer);
			for (let i = 0; i < decoded.count; i++) {
				const sample = item.points[Math.floor(i / 3)];
				expect(decoded.columns.lat[i] * CHUNK_SCALES.lat).toBeCloseTo(sample[0], 2);
				expect(decoded.columns.lon[i] * CHUNK_SCALES.lon).toBeCloseTo(sample[1], 2);
			}
		}
		const page = files.get('storms/index/0.json');
		expect(parseCatalogPage(JSON.parse(new TextDecoder().decode(page)), 0).storms).toHaveLength(5);
	});
});
