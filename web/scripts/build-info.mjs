import { execFileSync } from 'node:child_process';

function gitHead() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}

/** What this build was made from: CI variables first, then git, else unknown. */
export function buildInfo({ env = process.env, now = new Date(), head = gitHead } = {}) {
	const commit = env.SCINTILLE_COMMIT || env.GITHUB_SHA || head() || null;
	const pr = Number.parseInt(env.SCINTILLE_PR ?? '', 10);
	return {
		commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
		pr: Number.isInteger(pr) && pr > 0 ? pr : null,
		builtAt: now.toISOString(),
	};
}
