import { formatDate } from './components/hud/format';

export interface BuildInfo {
	/** Full commit SHA, or null when unknown (local build without git). */
	commit: string | null;
	/** Pull request number on a Preview. */
	pr: number | null;
	/** ISO 8601, UTC. */
	builtAt: string;
}

declare const __SCINTILLE_BUILD__: BuildInfo;

/** Injected by `astro.config.mjs` from `scripts/build-info.mjs`; absent under Vitest. */
export const BUILD: BuildInfo =
	typeof __SCINTILLE_BUILD__ === 'undefined' ? { commit: null, pr: null, builtAt: new Date(0).toISOString() } : __SCINTILLE_BUILD__;

const REPO = 'https://github.com/pierregc/scintille';

/** `Build 5c470ef · PR 183 · 11 Oct 2026`. */
export function versionLabel(info: BuildInfo): string {
	const t = Date.parse(info.builtAt);
	return [
		`Build ${info.commit?.slice(0, 7) ?? 'dev'}`,
		info.pr === null ? null : `PR ${info.pr}`,
		formatDate(t, 'UTC'),
	]
		.filter(Boolean)
		.join(' · ');
}

/** The pull request on a Preview, the commit otherwise. */
export function versionUrl(info: BuildInfo): string | null {
	if (info.pr !== null) return `${REPO}/pull/${info.pr}`;
	return info.commit ? `${REPO}/commit/${info.commit}` : null;
}
