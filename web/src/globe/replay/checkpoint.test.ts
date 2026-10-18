import { describe, expect, it } from 'vitest';
import { readFrameCheckpoint, sameFrame } from './checkpoint';

const saved = { slug: 'storm-a', fov: 35, aspect: 16 / 9, view: { lat: 28.5, lon: -81.3, altitude: 306, tilt: 12 } };

describe('verified reload frame checkpoints', () => {
	it('restores only the saved storm and viewport and returns an independent view', () => {
		expect(readFrameCheckpoint(saved, 'storm-a', 35, 16 / 9)).toEqual(saved.view);
		expect(readFrameCheckpoint(saved, 'storm-a', 35, 16 / 9)).not.toBe(saved.view);
		for (const [slug, fov, aspect] of [['storm-b', 35, 16 / 9], ['storm-a', 45, 16 / 9], ['storm-a', 35, 9 / 16]] as const) {
			expect(readFrameCheckpoint(saved, slug, fov, aspect)).toBeUndefined();
		}
	});
	it('rejects missing or malformed history state without preventing normal framing', () => {
		for (const value of [null, undefined, false, 'old-state', {}, { ...saved, view: null },
			{ ...saved, view: { ...saved.view, lat: NaN } }, { ...saved, view: { ...saved.view, lon: Infinity } },
			{ ...saved, view: { ...saved.view, altitude: '306' } }, { ...saved, view: { ...saved.view, tilt: 90 } },
			{ ...saved, view: { ...saved.view, lat: 91 } }, { ...saved, view: { ...saved.view, lon: -181 } },
			{ ...saved, view: { ...saved.view, altitude: 0 } }, { ...saved, view: { ...saved.view, altitude: 300_000 } }]) {
			expect(readFrameCheckpoint(value, 'storm-a', 35, 16 / 9)).toBeUndefined();
		}
	});
});

it('only skips a remembered frame when it still matches the current published storm framing', () => {
	expect(sameFrame(saved.view, saved.view)).toBe(true);
	expect(sameFrame(undefined, saved.view)).toBe(false);
	for (const change of [{ lat: 30 }, { lon: -70 }, { altitude: 500 }, { tilt: 20 }]) {
		expect(sameFrame(saved.view, { ...saved.view, ...change })).toBe(false);
	}
	expect(sameFrame({ ...saved.view, lon: -180 }, { ...saved.view, lon: 180 })).toBe(true);
});
