import { describe, expect, it } from 'vitest';
import type { LiveManifest } from '../../contract/types';
import { feedLabel, feedStatus, formatAge, sourcesNote, STALE_AFTER_MS } from './freshness';

const T = Date.UTC(2026, 6, 15, 19);

function manifest(generatedAt = T): LiveManifest {
	return {
		schema_version: '2.3.0',
		generated_at: new Date(generatedAt).toISOString(),
		chunk_seconds: 30,
		window_seconds: 3600,
		chunks: [],
		sources: [
			{ source: 'glm-east', state: 'live', last_event_time: new Date(T - 48_000).toISOString(), last_ingest_time: null },
			{ source: 'glm-west', state: 'delayed', last_event_time: null, last_ingest_time: null },
		],
	} as unknown as LiveManifest;
}

describe('feedStatus', () => {
	it('reports per-source age while fresh', () => {
		const status = feedStatus(manifest(), T, T);
		expect(status.stale).toBe(false);
		expect(status.sources.map((s) => [s.label, s.state, s.ageMs])).toEqual([
			['GLM East', 'live', 48_000],
			['GLM West', 'delayed', null],
		]);
	});

	it('goes stale when the feed stops updating', () => {
		expect(feedStatus(manifest(), T, T + STALE_AFTER_MS).stale).toBe(false);
		const stale = feedStatus(manifest(), T + 30_000, T + STALE_AFTER_MS + 1);
		expect(stale.stale).toBe(true);
		expect(stale.sources.every((s) => s.state === 'delayed')).toBe(true);
	});

	it('goes stale when no data has loaded since, even with a recent manifest', () => {
		expect(feedStatus(manifest(T), T, T + STALE_AFTER_MS + 1).stale).toBe(true);
	});

	it('is stale before any data has loaded', () => {
		expect(feedStatus(null, null, T)).toEqual({ stale: true, failing: false, ageMs: null, sources: [] });
	});
});

describe('feedLabel', () => {
	it('says Live only while the loaded data is fresh', () => {
		expect(feedLabel(feedStatus(manifest(), T, T + 60_000))).toEqual({ state: 'Live', banner: '' });
		expect(feedLabel(feedStatus(manifest(), T, T + 4 * 60_000, true))).toEqual({
			state: 'Delayed',
			banner: 'Live data is late · last update 4 min ago',
		});
	});

	it('tells waiting apart from an unreachable feed', () => {
		expect(feedLabel(feedStatus(null, null, T))).toEqual({
			state: 'Connecting',
			banner: 'Acquiring satellite data',
			loading: true,
		});
		expect(feedLabel(feedStatus(null, null, T, true))).toEqual({
			state: 'Offline',
			banner: 'Live data is unavailable',
		});
	});
});

describe('sourcesNote', () => {
	it('speaks only when a source is late', () => {
		expect(sourcesNote([{ state: 'live' }])).toBe('');
		expect(sourcesNote([{ state: 'live' }, { state: 'delayed' }])).toBe('Hyperwave relay running late');
		expect(sourcesNote([{ state: 'delayed' }, { state: 'offline' }])).toBe('Hyperwave relay silent · standing by');
	});
});

describe('formatAge', () => {
	it('picks a readable unit', () => {
		expect(formatAge(48_000)).toBe('48 s');
		expect(formatAge(12 * 60_000)).toBe('12 min');
		expect(formatAge(3 * 3_600_000)).toBe('3 h');
		expect(formatAge(5 * 86_400_000)).toBe('5 d');
	});
});
