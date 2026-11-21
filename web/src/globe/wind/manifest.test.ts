import { describe, expect, it } from 'vitest';
import { WIND_RULES } from '../../contract/wind';
import { parseWindArchive, parseWindManifest, WindManifestError, windSources } from './manifest';
import { archiveWindManifest, HOUR, liveWindManifest, windPath } from './testing';

const BASE = 'https://data.example/';
const T0 = Date.UTC(2026, 10, 21, 13);
const DAY = '2026-11-21';

type Json = Record<string, unknown> & { frames: (Record<string, unknown> & { levels: Record<string, Record<string, unknown>> })[] };
const live = () => structuredClone(liveWindManifest([T0, T0 + HOUR])) as unknown as Json;
const archive = () => structuredClone(archiveWindManifest(DAY, [T0, T0 + HOUR])) as unknown as Json;

describe('parseWindManifest', () => {
	it('accepts the live manifest and resolves its textures into the archive', () => {
		const manifest = parseWindManifest(live());
		const sources = windSources(manifest.frames, `${BASE}live/wind/manifest.json`);
		expect(sources).toHaveLength(4);
		expect(sources[0]).toEqual({
			time: T0,
			level: '10m',
			url: `${BASE}archive/wind/10m/2026/11/21/20261121T13Z-1a2b3c4d.webp`,
			scaleMs: 40,
			expires: Infinity,
		});
		expect(sources[1]).toMatchObject({ level: '250hPa', scaleMs: 120 });
	});

	it.each<[string, (m: Json) => void]>([
		['no frames', (m) => delete (m as Record<string, unknown>).frames],
		['no attribution', (m) => delete m.attribution],
		['no window', (m) => delete m.window_seconds],
		['too many frames', (m) => { m.frames = Array.from({ length: WIND_RULES.max_frames + 1 }, () => m.frames[0]); }],
		['a bad time', (m) => { m.frames[0].time = 'soon'; }],
		['no levels', (m) => delete (m.frames[0] as Record<string, unknown>).levels],
		['an unknown level', (m) => { m.frames[0].levels['850hPa'] = { ...m.frames[0].levels['10m'] }; }],
		['an inherited level name', (m) => { m.frames[0].levels = JSON.parse('{"toString": {}}') as Json['frames'][0]['levels']; }],
		['an archive path', (m) => { m.frames[0].levels['10m'].path = windPath('10m', T0, '../'); }],
		['an absolute path', (m) => { m.frames[0].levels['10m'].path = 'https://other.example/10m/2026/11/21/a.webp'; }],
		['a path escaping the archive', (m) => { m.frames[0].levels['10m'].path = '../../archive/wind/10m/2026/11/21/../../a.webp'; }],
		['a path of another level', (m) => { m.frames[0].levels['10m'].path = windPath('250hPa', T0, '../../archive/wind/'); }],
		['a path that is not WebP', (m) => { m.frames[0].levels['10m'].path = '../../archive/wind/10m/2026/11/21/a.png'; }],
		['a wrong width', (m) => { m.frames[0].levels['10m'].width = 721; }],
		['a wrong height', (m) => { m.frames[0].levels['10m'].height = 360; }],
		['an empty texture', (m) => { m.frames[0].levels['10m'].size_bytes = 0; }],
		['an oversized texture', (m) => { m.frames[0].levels['10m'].size_bytes = WIND_RULES.max_frame_bytes + 1; }],
		['a fractional size', (m) => { m.frames[0].levels['10m'].size_bytes = 1.5; }],
		['a scale off contract', (m) => { m.frames[0].levels['250hPa'].scale_ms = 40; }],
	])('rejects %s', (_, change) => {
		const manifest = live();
		change(manifest);
		expect(() => parseWindManifest(manifest)).toThrow(WindManifestError);
	});

	it('rejects what is not a manifest', () => {
		expect(() => parseWindManifest(null)).toThrow(WindManifestError);
		expect(() => parseWindManifest([])).toThrow(WindManifestError);
	});

	it('accepts a frame with one level', () => {
		const manifest = live();
		delete manifest.frames[0].levels['10m'];
		expect(windSources(parseWindManifest(manifest).frames, BASE).map((s) => s.level)).toEqual(['250hPa', '10m', '250hPa']);
	});
});

describe('parseWindArchive', () => {
	it('accepts a daily index and resolves its textures next to it', () => {
		const manifest = parseWindArchive(archive(), DAY);
		const [source] = windSources(manifest.frames, `${BASE}archive/wind/manifests/${DAY}.json`);
		expect(source.url).toBe(`${BASE}archive/wind/10m/2026/11/21/20261121T13Z-1a2b3c4d.webp`);
		expect(source.expires).toBe(T0 + 30 * 24 * HOUR);
	});

	it.each<[string, (m: Json) => void]>([
		['another schema version', (m) => { m.schema_version = WIND_RULES.schema_version + 1; }],
		['no schema version', (m) => delete m.schema_version],
		['another day', (m) => { m.day = '2026-11-20'; }],
		['a frame of another day', (m) => { m.frames[1].time = '2026-11-22T00:00:00Z'; }],
		['a frame without expiry', (m) => delete m.frames[0].expires_at],
		['a live path', (m) => { m.frames[0].levels['10m'].path = windPath('10m', T0, '../../archive/wind/'); }],
		['a wrong size', (m) => { m.frames[0].levels['10m'].width = 1440; }],
		['too many frames', (m) => { m.frames = Array.from({ length: WIND_RULES.max_frames + 1 }, () => m.frames[0]); }],
	])('rejects %s', (_, change) => {
		const manifest = archive();
		change(manifest);
		expect(() => parseWindArchive(manifest, DAY)).toThrow(WindManifestError);
	});
});
