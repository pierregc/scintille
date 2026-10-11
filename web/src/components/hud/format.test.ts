import { describe, expect, it } from 'vitest';
import { cloudCaption, formatUtcDate, formatUtcTime } from './format';

describe('HUD formatting', () => {
	it('shows UTC whatever the local zone', () => {
		const t = Date.UTC(2026, 6, 5, 3, 4, 9);
		expect(formatUtcTime(t)).toBe('03:04:09');
		expect(formatUtcDate(t)).toBe('05 Jul 2026');
	});

	it('captions the cloud frame time, or its absence once the feed has answered', () => {
		const t = Date.UTC(2026, 6, 15, 18);
		expect(cloudCaption(true, t, true)).toBe('Observed 18:00 UTC');
		expect(cloudCaption(true, null, false)).toBe('');
		expect(cloudCaption(true, null, true)).toBe('No cloud data');
		expect(cloudCaption(false, t, true)).toBe('');
	});
});
