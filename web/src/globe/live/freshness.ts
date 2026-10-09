import type { LiveManifest, Source, SourceState } from '../../contract/types';

/** Beyond this age the whole feed is stale and must not be shown as live. */
export const STALE_AFTER_MS = 180_000;

export const SOURCE_LABELS: Record<Source, string> = {
	'glm-east': 'GLM East',
	'glm-west': 'GLM West',
	'mtg-li': 'MTG LI',
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
	/** Age of the feed: since the manifest was generated, or since the last successful poll if older. */
	ageMs: number | null;
	sources: SourceFreshness[];
}

/** Freshness of the live feed at `now`, from the latest manifest and when it was received. */
export function feedStatus(manifest: LiveManifest | null, receivedAt: number | null, now: number): FeedStatus {
	if (!manifest || receivedAt === null) return { stale: true, ageMs: null, sources: [] };
	const generated = Date.parse(manifest.generated_at);
	const ageMs = Math.max(now - generated, now - receivedAt, 0);
	const stale = !(ageMs <= STALE_AFTER_MS);
	const sources = (manifest.sources ?? []).map((s) => ({
		source: s.source,
		label: SOURCE_LABELS[s.source] ?? s.source,
		state: stale ? ('delayed' as const) : s.state,
		ageMs: s.last_event_time ? Math.max(now - Date.parse(s.last_event_time), 0) : null,
	}));
	return { stale, ageMs, sources };
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
