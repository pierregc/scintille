import { describe, expect, it } from 'vitest';
import { nextTrack } from './ambient';
import catalog from './catalog.json';

const tracks = [{ id: 'a', loop: 30 }, { id: 'b', loop: 40 }, { id: 'c', loop: 50 }];

describe('nextTrack', () => {
	it('never repeats the track playing', () => {
		for (const current of tracks) {
			for (const r of [0, 0.5, 0.999999, 1]) expect(nextTrack(tracks, current, () => r)).not.toBe(current);
		}
	});

	it('reaches every other track', () => {
		const seen = new Set([0, 0.4, 0.9].map((r) => nextTrack(tracks, tracks[0], () => r).id));
		expect([...seen].sort()).toEqual(['b', 'c']);
	});

	it('keeps a single track', () => {
		expect(nextTrack(tracks.slice(0, 1), tracks[0])).toBe(tracks[0]);
		expect(() => nextTrack([], null)).toThrow();
	});
});

describe('catalog', () => {
	it('lists seamless tracks and CC0 sources for every file', () => {
		expect(catalog.tracks.length).toBeGreaterThan(1);
		for (const t of catalog.tracks) {
			expect(t.loop).toBeGreaterThan(20);
			expect(t.loop).toBeLessThanOrEqual(84);
			expect(catalog.sources.find((s) => s.id === t.id)?.license).toBe('CC0-1.0');
		}
		expect(catalog.crackles.length).toBeGreaterThanOrEqual(8);
		expect(catalog.sources.every((s) => s.license === 'CC0-1.0')).toBe(true);
	});
});
