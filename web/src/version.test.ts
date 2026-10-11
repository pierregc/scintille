import { describe, expect, it } from 'vitest';
import { type BuildInfo, versionLabel, versionUrl } from './version';

const SHA = '5c470eff9b2386881894ac5551f2ba321a70372b';
const main: BuildInfo = { commit: SHA, pr: null, builtAt: '2026-10-11T19:30:42.000Z' };

describe('version', () => {
	it('labels a production build with its short SHA and build time', () => {
		expect(versionLabel(main)).toBe('Build 5c470ef · 11 Oct 2026 19:30 UTC');
		expect(versionUrl(main)).toBe(`https://github.com/pierregc/scintille/commit/${SHA}`);
	});

	it('names the PR on a Preview and links to it', () => {
		const preview = { ...main, pr: 183 };
		expect(versionLabel(preview)).toBe('Build 5c470ef · PR 183 · 11 Oct 2026 19:30 UTC');
		expect(versionUrl(preview)).toBe('https://github.com/pierregc/scintille/pull/183');
	});

	it('falls back to dev without a commit', () => {
		const dev = { ...main, commit: null };
		expect(versionLabel(dev)).toBe('Build dev · 11 Oct 2026 19:30 UTC');
		expect(versionUrl(dev)).toBeNull();
	});
});
