import { describe, expect, it } from 'vitest';
import { parseReplayLocation, replayUrl } from './url';

it('round trips time, speed, paused state and supported camera values while retaining unrelated parameters', () => {
	const state = { slug: 'storm-one', time: Date.parse('2026-07-15T18:01:02.123Z'), speed: 30, paused: true,
		view: { lat: 28.5, lon: -81.3, altitude: 2000, tilt: 12 } };
	const url = replayUrl(new URL('https://scintille.app/?quality=low&debug=1#globe'), state);
	expect(parseReplayLocation(url)).toEqual(state);
	expect(url.searchParams.get('quality')).toBe('low');
	expect(url.hash).toBe('#globe');
	const live = replayUrl(url, null);
	expect(live.searchParams.has('storm')).toBe(false);
	expect(live.searchParams.get('debug')).toBe('1');
});

describe('URL validation', () => {
	it.each(['../secret', '', 'UPPER', 'a/b'])('rejects invalid slugs (%s)', (slug) => {
		const url = new URL('https://scintille.app/'); url.searchParams.set('storm', slug);
		expect(parseReplayLocation(url)).toBeNull();
	});
	it('defaults malformed optional values and bounds altitude/tilt', () => {
		const state = parseReplayLocation(new URL('https://scintille.app/?storm=one&speed=Infinity&time=2026-02-30T00:00:00Z&view=0,180,-50,900'));
		expect(state).toMatchObject({ speed: 60, time: undefined, view: { altitude: 20, tilt: 80 } });
		for (const view of ['NaN,0,20,0', '0,0', '91,0,20,0', '0,,20,0']) {
			const url = new URL('https://scintille.app/?storm=one'); url.searchParams.set('view', view);
			expect(parseReplayLocation(url)?.view).toBeUndefined();
		}
	});
});
