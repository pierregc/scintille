import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OpsMetrics } from '../contract/types';
import { MetricsFormatError, parseMetrics, statusView } from './metrics';

const fixture = (): OpsMetrics =>
	JSON.parse(readFileSync(new URL('../../../fixtures/live/metrics.json', import.meta.url), 'utf8')) as OpsMetrics;

const T = Date.UTC(2026, 6, 15, 19);

function nth<T>(items: T[], i: number): T {
	const item = items[i];
	if (item === undefined) throw new Error(`no item ${i}`);
	return item;
}

describe('parseMetrics', () => {
	it('accepts the fixture', () => {
		expect(parseMetrics(fixture()).sources).toHaveLength(3);
	});

	it('rejects another major version or a missing section', () => {
		expect(() => parseMetrics({ ...fixture(), schema_version: '3.0.0' })).toThrow(MetricsFormatError);
		expect(() => parseMetrics({ ...fixture(), quality: undefined })).toThrow(MetricsFormatError);
		expect(() => parseMetrics({ ...fixture(), generated_at: 'soon' })).toThrow(MetricsFormatError);
		expect(() => parseMetrics(null)).toThrow(MetricsFormatError);
	});
});

describe('statusView', () => {
	it('shows the numbers of metrics.json', () => {
		const m = fixture();
		const view = statusView(m, T, T);
		expect(view.stale).toBe(false);
		expect(view.banner).toBe('');
		const west = nth(view.sources, 1);
		const raw = nth(m.sources, 1);
		expect(west.label).toBe('GLM West');
		expect(west.flashesPerMinute).toEqual(raw.flashes_per_minute);
		expect(west.lastMinute).toBe(raw.flashes_per_minute.at(-2));
		expect(west.latencyP95.text).toBe(`${Math.round(raw.latency_p95_seconds ?? NaN)} s`);
		expect(west.completeness).toEqual({ text: '93.3 %', verdict: 'missed', target: '≥ 99 %' });
		expect(west.errorBudget).toBe('61 %');
		expect(west.lastFile).toBe('4 min ago');
		expect(nth(view.sources, 0).completeness.verdict).toBe('met');
		expect(nth(view.sources, 0).latencyP95.verdict).toBe('met');
		expect(view.quality).toMatchObject({ status: 'warn', failed: ['silver_volume'], checkedAt: '5 min ago' });
		expect(view.catalog).toEqual({ text: '21,480 / 1,000,000', share: '2.1 %' });
	});

	it('checks each layer against its target and advances ages', () => {
		const m = fixture();
		m.freshness = { live_feed_age_seconds: 6, silver_lag_seconds: 880, gold_age_seconds: null };
		const view = statusView(m, T, T + 30_000);
		expect(view.freshness.map((l) => [l.label, l.measure.text, l.measure.verdict])).toEqual([
			['Live feed', '36 s', 'met'],
			['Silver', '15 min', 'missed'],
			['Gold', '—', 'unknown'],
		]);
	});

	it('keeps a drained spool at zero', () => {
		const m = fixture();
		m.freshness.silver_lag_seconds = 0;
		expect(nth(statusView(m, T, T + 60_000).freshness, 1).measure.text).toBe('0 s');
	});

	it('marks a missed latency target', () => {
		const m = fixture();
		nth(m.sources, 2).latency_p95_seconds = 121;
		expect(nth(statusView(m, T, T).sources, 2).latencyP95.verdict).toBe('missed');
	});

	it('does not vouch for old metrics', () => {
		const view = statusView(fixture(), T, T + 3 * 86_400_000);
		expect(view.stale).toBe(true);
		expect(view.state).toBe('Delayed');
		expect(view.banner).toBe('Metrics are late · last update 3 d ago');
		const verdicts = [...view.freshness.map((l) => l.measure), ...view.sources.flatMap((s) => [s.latencyP95, s.completeness])];
		expect(verdicts.every((m) => m.verdict === 'unknown')).toBe(true);
	});

	it('says when there is nothing to show', () => {
		expect(statusView(null, null, T)).toMatchObject({ stale: true, state: 'Connecting', sources: [] });
		expect(statusView(null, null, T, true)).toMatchObject({ state: 'Offline', banner: 'Metrics are unavailable' });
	});

	it('handles a source without flashes or files', () => {
		const m = fixture();
		Object.assign(nth(m.sources, 0), {
			flashes_per_minute: [],
			latency_p50_seconds: null,
			latency_p95_seconds: null,
			completeness: null,
			last_file_time: null,
			error_budget_remaining: null,
		});
		const s = nth(statusView(m, T, T).sources, 0);
		expect([s.lastMinute, s.latencyP50, s.latencyP95.verdict, s.completeness.text, s.lastFile]).toEqual([
			null,
			'—',
			'unknown',
			'—',
			'never',
		]);
	});
});
