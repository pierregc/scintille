import { describe, expect, it } from 'vitest';
import { buildInfo } from './build-info.mjs';

const SHA = '5c470eff9b2386881894ac5551f2ba321a70372b';
const now = new Date(Date.UTC(2026, 9, 11, 19, 30));

describe('buildInfo', () => {
	it('prefers the explicit commit, then GitHub, then git', () => {
		const head = () => 'aaaaaaa';
		expect(buildInfo({ env: { SCINTILLE_COMMIT: SHA, GITHUB_SHA: 'bbbbbbb' }, now, head }).commit).toBe(SHA);
		expect(buildInfo({ env: { GITHUB_SHA: SHA }, now, head }).commit).toBe(SHA);
		expect(buildInfo({ env: {}, now, head }).commit).toBe('aaaaaaa');
	});

	it('builds without git or CI', () => {
		expect(buildInfo({ env: {}, now, head: () => null })).toEqual({
			commit: null,
			pr: null,
			builtAt: '2026-10-11T19:30:00.000Z',
		});
	});

	it('keeps only a valid SHA and PR number', () => {
		expect(buildInfo({ env: { SCINTILLE_COMMIT: 'main', SCINTILLE_PR: '183' }, now, head: () => null })).toMatchObject({
			commit: null,
			pr: 183,
		});
		expect(buildInfo({ env: { SCINTILLE_PR: 'x' }, now, head: () => null }).pr).toBeNull();
	});
});
