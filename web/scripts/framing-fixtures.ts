import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import original from '../../fixtures/storms/2026-07-15-orlando.json';
import type { StormDetail, StormIndexPage, StormSummary } from '../src/contract/types';
import { SCHEMA_VERSION } from '../src/contract/types';
import cases from '../src/globe/replay/framing-cases.json';
import { encodeChunk } from '../src/globe/live/testing';

/** Synthetic geometry and scene-time exercises; called only from the Preview fixture build hook. */
export function framingFixtures(): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	const summaries: StormSummary[] = [original.storm as StormSummary];
	const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
	for (const item of cases.slice(1)) {
		const start = Date.parse(item.start);
		const flashes = item.points.flatMap(([lat, lon], i) => Array.from({ length: 3 }, (_, j) => ({ lat, lon, offsetMs: i * 360_000 + j * 10_000, source: 0 })));
		const bytes = gzipSync(encodeChunk(start / 1000, flashes));
		const path = `storms/chunks/${createHash('sha256').update(bytes).digest('hex')}.bin.gz`;
		const end = new Date(start + (flashes.at(-1)?.offsetMs ?? 0)).toISOString();
		const storm: StormSummary = { ...original.storm, storm_id: item.slug, slug: item.slug, name: item.label, label: item.label,
			country_code: null, t_start: item.start, t_end: end, flashes: flashes.length, peak_rate: 3, level: 1, sources: ['glm-east'] };
		const detail: StormDetail = { ...original, schema_version: SCHEMA_VERSION, storm, bounds: item.bounds, published_at: new Date(Date.parse(end) + 3_600_000).toISOString(), last_observation_time: end,
			track: item.points.map(([lat, lon], i) => ({ lat, lon, time: new Date(start + i * 360_000).toISOString(), flash_count: 3, area_km2: 1 })),
			replay: { selection: 'track-bounds', flash_count: flashes.length, chunks: [{ ...original.replay.chunks[0], path, start: item.start,
				end: new Date(start + 3_600_000).toISOString(), event_min: item.start, event_max: end, size_bytes: bytes.byteLength, flash_count: flashes.length }] } };
		files.set(`storms/${item.slug}.json`, json(detail));
		files.set(path, bytes);
		summaries.push(storm);
	}
	summaries.sort((a, b) => Date.parse(b.t_start) - Date.parse(a.t_start));
	const page: StormIndexPage = { schema_version: SCHEMA_VERSION, published_at: new Date(Date.parse(summaries[0].t_end) + 3_600_000).toISOString(), last_observation_time: summaries[0].t_end,
		page: 0, page_size: 50, total_pages: 1, total_storms: summaries.length, storms: summaries };
	files.set('storms/index/0.json', json(page));
	return files;
}
