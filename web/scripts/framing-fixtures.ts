import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import original from '../../fixtures/storms/2026-07-15-orlando.json';
import type { StormBounds, StormDetail, StormIndexPage, StormSummary } from '../src/contract/types';
import { SCHEMA_VERSION } from '../src/contract/types';
import cases from '../src/globe/replay/framing-cases.json';
import type { FakeFlash } from '../src/globe/live/testing';
import { encodeChunk } from '../src/globe/live/testing';

export const TRACK_STEP_MS = 900_000;
const FLASHES = 480;

type Case = (typeof cases)[number];

const wrap = (lon: number) => ((lon + 540) % 360) - 180;

/** Scatter radius around the track centre, in degrees. */
export function scatterDegrees({ west, east, south, north }: StormBounds): number {
	const width = east >= west ? east - west : east + 360 - west;
	return Math.min(0.8, Math.max(0.03, 0.06 * Math.min(north - south, width)));
}

export function trackAt(points: number[][], offsetMs: number): [number, number] {
	const step = Math.min(offsetMs / TRACK_STEP_MS, points.length - 1);
	const i = Math.min(Math.floor(step), points.length - 2);
	if (i < 0) return [points[0][0], points[0][1]];
	const f = step - i;
	const [a, b] = [points[i], points[i + 1]];
	return [a[0] + (b[0] - a[0]) * f, wrap(a[1] + wrap(b[1] - a[1]) * f)];
}

function random(seed: string): () => number {
	let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function stormFlashes(item: Case): FakeFlash[] {
	const next = random(item.slug);
	const span = (item.points.length - 1) * TRACK_STEP_MS;
	const radius = scatterDegrees(item.bounds);
	const { west, east, south, north } = item.bounds;
	const width = east >= west ? east - west : east + 360 - west;
	const flashes: FakeFlash[] = [];
	while (flashes.length < FLASHES) {
		const offsetMs = Math.round(next() * span);
		if (next() > 0.2 + 0.8 * Math.sin(Math.PI * offsetMs / span)) continue;
		const [lat, lon] = trackAt(item.points, offsetMs);
		const r = radius * Math.sqrt(-2 * Math.log(1 - next()));
		const angle = 2 * Math.PI * next();
		const d = (((lon + r * Math.sin(angle) - west) % 360) + 360) % 360;
		const fromWest = d <= width ? d : d - width < 360 - d ? width : 0;
		flashes.push({ offsetMs, source: 0,
			lat: Math.min(north, Math.max(south, lat + r * Math.cos(angle))),
			lon: wrap(west + fromWest) });
	}
	return flashes.sort((a, b) => a.offsetMs - b.offsetMs);
}

/** Synthetic geometry and scene-time exercises; called only from the Preview fixture build hook. */
export function framingFixtures(): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	const summaries: StormSummary[] = [original.storm as StormSummary];
	const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
	for (const item of cases.slice(1)) {
		const start = Date.parse(item.start);
		const flashes = stormFlashes(item);
		const perMinute = new Map<number, number>();
		const perPoint = item.points.map(() => 0);
		for (const flash of flashes) {
			const minute = Math.floor(flash.offsetMs / 60_000);
			perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
			perPoint[Math.round(flash.offsetMs / TRACK_STEP_MS)]++;
		}
		const bytes = gzipSync(encodeChunk(start / 1000, flashes));
		const path = `storms/chunks/${createHash('sha256').update(bytes).digest('hex')}.bin.gz`;
		const end = new Date(start + (flashes.at(-1)?.offsetMs ?? 0)).toISOString();
		const storm: StormSummary = { ...original.storm, storm_id: item.slug, slug: item.slug, name: item.label, label: item.label,
			country_code: null, t_start: item.start, t_end: end, flashes: flashes.length, peak_rate: Math.max(...perMinute.values()), level: 1, sources: ['glm-east'] };
		const detail: StormDetail = { ...original, schema_version: SCHEMA_VERSION, storm, bounds: item.bounds, published_at: new Date(Date.parse(end) + 3_600_000).toISOString(), last_observation_time: end,
			track: item.points.map(([lat, lon], i) => ({ lat, lon, time: new Date(start + i * TRACK_STEP_MS).toISOString(), flash_count: perPoint[i], area_km2: 1 })),
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
