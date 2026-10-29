import type { CheckStatus, OpsMetrics, Source } from '../contract/types';
import { CONTRACT_MAJOR } from '../globe/live/decode';
import { formatAge, SOURCE_LABELS, STALE_AFTER_MS } from '../globe/live/freshness';

/** Targets from docs/slo.md. */
export const SLO = {
	latencyP95Seconds: { 'glm-east': 45, 'glm-west': 45, 'mtg-li': 660 } satisfies Record<Source, number>,
	completeness: 0.99,
	liveFeedAgeSeconds: 120,
	silverLagSeconds: 15 * 60,
	goldAgeSeconds: 26 * 3600,
	/** Both are measured hourly; one missed run is tolerated. */
	lakeAgeSeconds: 2 * 3600,
	stormsAgeSeconds: 2 * 3600,
} as const;

export class MetricsFormatError extends Error {}

/** Checks the parts of `metrics.json` the page relies on; the full contract is enforced by the writer. */
export function parseMetrics(json: unknown): OpsMetrics {
	if (typeof json !== 'object' || json === null) throw new MetricsFormatError('metrics is not an object');
	const m = json as Partial<OpsMetrics>;
	const major = Number(String(m.schema_version ?? '').split('.')[0]);
	if (major !== CONTRACT_MAJOR) {
		throw new MetricsFormatError(`metrics major version ${String(m.schema_version)}, expected ${CONTRACT_MAJOR}`);
	}
	if (typeof m.generated_at !== 'string' || Number.isNaN(Date.parse(m.generated_at))) {
		throw new MetricsFormatError('metrics without a valid generated_at');
	}
	if (!Array.isArray(m.sources) || !m.freshness || !m.quality || !m.catalog) {
		throw new MetricsFormatError('metrics is missing a section');
	}
	return m as OpsMetrics;
}

/** `unknown` when the value is missing or the metrics are not current. */
export type Verdict = 'met' | 'missed' | 'unknown';

function verdict(value: number | null, ok: (v: number) => boolean, current: boolean): Verdict {
	if (!current || value === null) return 'unknown';
	return ok(value) ? 'met' : 'missed';
}

export interface Measure {
	text: string;
	verdict: Verdict;
	target: string;
}

export interface SourceView {
	source: Source;
	label: string;
	seriesStartMs: number;
	flashesPerMinute: number[];
	/** Flashes in the last complete minute; null without one. */
	lastMinute: number | null;
	latencyP50: string;
	latencyP95: Measure;
	completeness: Measure;
	errorBudget: string;
	lastFile: string;
}

export interface StatusView {
	/** No metrics loaded, or the loaded ones are too old to describe the present. */
	stale: boolean;
	state: string;
	/** Empty when current. */
	banner: string;
	generatedAtMs: number | null;
	freshness: { label: string; measure: Measure }[];
	sources: SourceView[];
	quality: { status: CheckStatus; text: string; failed: string[]; checkedAt: string };
	catalog: { text: string; share: string } | null;
	lake: { size: string; tables: string; files: string; rows: string; measured: Measure } | null;
	storms: { detected: string; published: string; highlighted: string; measured: Measure } | null;
}

const dash = '—';

export function formatSeconds(s: number | null): string {
	return s === null ? dash : formatAge(s * 1000);
}

export function formatPercent(share: number | null, digits = 1): string {
	return share === null ? dash : `${(share * 100).toFixed(digits)} %`;
}

export function formatCount(n: number | null): string {
	return n === null ? dash : n.toLocaleString('en-US');
}

/** Decimal units, as storage is billed. */
export function formatBytes(n: number | null): string {
	if (n === null) return dash;
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = n;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i += 1;
	}
	return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

/** Age of a measurement made `at`, against a freshness target. */
function measured(at: string | null | undefined, now: number, target: number, targetText: string, current: boolean): Measure {
	const age = at ? Math.max(now - Date.parse(at), 0) / 1000 : null;
	return {
		text: age === null ? 'never' : `${formatAge(age * 1000)} ago`,
		verdict: verdict(age, (v) => v < target, current),
		target: targetText,
	};
}

function since(iso: string | null, now: number): string {
	return iso === null ? 'never' : `${formatAge(Math.max(now - Date.parse(iso), 0))} ago`;
}

const QUALITY_TEXT: Record<CheckStatus, string> = {
	pass: 'All checks pass',
	warn: 'Warnings',
	fail: 'Failing',
	unknown: 'Not checked yet',
};

/**
 * What the page shows at `now` for the latest metrics, loaded at `loadedAt`. Layer ages are advanced
 * by the time elapsed since the metrics were generated.
 */
export function statusView(
	metrics: OpsMetrics | null,
	loadedAt: number | null,
	now: number,
	failing = false,
): StatusView {
	if (!metrics || loadedAt === null) {
		return {
			stale: true,
			state: failing ? 'Offline' : 'Connecting',
			banner: failing ? 'Metrics are unavailable' : 'Waiting for metrics',
			generatedAtMs: null,
			freshness: [],
			sources: [],
			quality: { status: 'unknown', text: dash, failed: [], checkedAt: dash },
			catalog: null,
			lake: null,
			storms: null,
		};
	}
	const generated = Date.parse(metrics.generated_at);
	const elapsed = Math.max(now - generated, 0) / 1000;
	const ageMs = Math.max(now - generated, now - loadedAt, 0);
	const current = ageMs <= STALE_AFTER_MS;
	const advance = (s: number | null) => (s === null ? null : s + elapsed);
	const f = metrics.freshness;
	const lake = metrics.lake as OpsMetrics['lake'] | undefined;
	const storms = metrics.storms as OpsMetrics['storms'] | undefined;
	const layer = (label: string, value: number | null, target: number, targetText: string) => ({
		label,
		measure: {
			text: formatSeconds(value),
			verdict: verdict(value, (v) => v < target, current),
			target: targetText,
		},
	});
	return {
		stale: !current,
		state: current ? 'Live' : 'Delayed',
		banner: current ? '' : `Metrics are late · last update ${formatAge(ageMs)} ago`,
		generatedAtMs: generated,
		freshness: [
			layer('Live feed', advance(f.live_feed_age_seconds), SLO.liveFeedAgeSeconds, '< 2 min'),
			// A drained spool stays at 0 until the next report.
			layer('Silver', f.silver_lag_seconds === 0 ? 0 : advance(f.silver_lag_seconds), SLO.silverLagSeconds, '< 15 min'),
			layer('Gold', advance(f.gold_age_seconds), SLO.goldAgeSeconds, '< 26 h'),
		],
		sources: metrics.sources.map((s) => ({
			source: s.source,
			label: SOURCE_LABELS[s.source] ?? s.source,
			seriesStartMs: Date.parse(s.series_start),
			flashesPerMinute: s.flashes_per_minute,
			lastMinute: s.flashes_per_minute.at(-2) ?? null,
			latencyP50: s.latency_p50_seconds === null ? dash : `${Math.round(s.latency_p50_seconds)} s`,
			latencyP95: {
				text: s.latency_p95_seconds === null ? dash : `${Math.round(s.latency_p95_seconds)} s`,
				verdict: verdict(s.latency_p95_seconds, (v) => v <= SLO.latencyP95Seconds[s.source], current),
				target: `≤ ${formatAge(SLO.latencyP95Seconds[s.source] * 1000)}`,
			},
			completeness: {
				text: formatPercent(s.completeness),
				verdict: verdict(s.completeness, (v) => v >= SLO.completeness, current),
				target: '≥ 99 %',
			},
			errorBudget: formatPercent(s.error_budget_remaining, 0),
			lastFile: since(s.last_file_time, now),
		})),
		quality: {
			status: metrics.quality.status,
			text: QUALITY_TEXT[metrics.quality.status] ?? metrics.quality.status,
			failed: metrics.quality.failed,
			checkedAt: since(metrics.quality.checked_at, now),
		},
		catalog: {
			text: `${formatCount(metrics.catalog.operations)} / ${formatCount(metrics.catalog.free_tier)}`,
			share: metrics.catalog.free_tier > 0 ? formatPercent(metrics.catalog.operations / metrics.catalog.free_tier) : dash,
		},
		// Absent before contract 2.7: shown as never measured.
		lake: {
			size: formatBytes(lake?.bytes ?? null),
			tables: formatCount(lake?.tables ?? null),
			files: formatCount(lake?.data_files ?? null),
			rows: formatCount(lake?.records ?? null),
			measured: measured(lake?.measured_at, now, SLO.lakeAgeSeconds, '< 2 h', current),
		},
		storms: {
			detected: formatCount(storms?.detected ?? null),
			published: formatCount(storms?.published ?? null),
			highlighted: formatCount(storms?.highlighted ?? null),
			measured: measured(storms?.measured_at, now, SLO.stormsAgeSeconds, '< 2 h', current),
		},
	};
}
