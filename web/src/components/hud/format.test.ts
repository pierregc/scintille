import { describe, expect, it } from 'vitest';
import { formatUtcDate, formatUtcTime } from './format';

describe('HUD formatting', () => {
	it('shows UTC whatever the local zone', () => {
		const t = Date.UTC(2026, 6, 5, 3, 4, 9);
		expect(formatUtcTime(t)).toBe('03:04:09');
		expect(formatUtcDate(t)).toBe('05 Jul 2026');
	});
});
