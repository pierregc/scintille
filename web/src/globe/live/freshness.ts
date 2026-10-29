import type { LiveManifest, Source, SourceState } from '../../contract/types';

/** Beyond this age the whole feed is stale and must not be shown as live. */
export const STALE_AFTER_MS = 180_000;

export const SOURCE_LABELS: Record<Source, string> = {
	'glm-east': 'GLM East',
	'glm-west': 'GLM West',
	'mtg-li': 'MTG LI',
};

/** What each source covers, for visitors. */
export const SOURCE_REGIONS: Record<Source, string> = {
	'glm-east': 'Americas',
	'glm-west': 'Pacific',
	'mtg-li': 'Europe & Africa',
};

export interface SourceFreshness {
	source: Source;
	label: string;
	state: SourceState;
	/** Age of the latest flash from this source, ms; null if never seen. */
	ageMs: number | null;
}

export interface FeedStatus {
	stale: boolean;
	/** Polls are currently failing. */
	failing: boolean;
	/** Age of the loaded data: since its manifest was generated, or since it was loaded if older. */
	ageMs: number | null;
	sources: SourceFreshness[];
}

/**
 * Freshness at `now` of the data actually in the ring: `manifest` is the latest one whose chunks all
 * loaded, `loadedAt` when that happened.
 */
export function feedStatus(
	manifest: LiveManifest | null,
	loadedAt: number | null,
	now: number,
	failing = false,
): FeedStatus {
	if (!manifest || loadedAt === null) return { stale: true, failing, ageMs: null, sources: [] };
	const generated = Date.parse(manifest.generated_at);
	const ageMs = Math.max(now - generated, now - loadedAt, 0);
	const stale = !(ageMs <= STALE_AFTER_MS);
	const sources = (manifest.sources ?? []).map((s) => ({
		source: s.source,
		label: SOURCE_LABELS[s.source] ?? s.source,
		state: stale ? ('delayed' as const) : s.state,
		ageMs: s.last_event_time ? Math.max(now - Date.parse(s.last_event_time), 0) : null,
	}));
	return { stale, failing, ageMs, sources };
}

/** HUD wording for a feed status: the state next to the pulse, and the banner (empty when fresh). */
export function feedLabel(status: FeedStatus): { state: string; banner: string; loading?: boolean } {
	if (!status.stale) return { state: 'Live', banner: '' };
	if (status.ageMs === null) {
		return status.failing
			? { state: 'Offline', banner: 'Live data is unavailable' }
			: { state: 'Connecting', banner: 'Acquiring satellite data', loading: true };
	}
	return { state: 'Delayed', banner: `Live data is late · last update ${formatAge(status.ageMs)} ago` };
}

/** A playful line under late sources; empty while they are all live. */
export function sourcesNote(sources: Pick<SourceFreshness, 'state'>[]): string {
	if (sources.some((s) => s.state === 'offline')) return 'Hyperwave relay silent · standing by';
	if (sources.some((s) => s.state === 'delayed')) return 'Hyperwave relay running late';
	return '';
}

/** `48 s`, `12 min`, `3 h`, `2 d`. */
export function formatAge(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const min = Math.round(s / 60);
	if (min < 60) return `${min} min`;
	const h = Math.round(min / 60);
	if (h < 48) return `${h} h`;
	return `${Math.round(h / 24)} d`;
}
