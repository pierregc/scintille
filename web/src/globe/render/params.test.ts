import { describe, expect, it } from 'vitest';
import { frameTime, parseRenderParams, RENDER_DEFAULTS } from './params';

const START = Date.UTC(2026, 6, 15, 18, 30);
const END = Date.UTC(2026, 6, 15, 18, 31);
const RANGE = 'start=2026-07-15T18:30:00Z&end=2026-07-15T18:31:00Z';

describe('parseRenderParams', () => {
	it('fills defaults around the time range', () => {
		expect(parseRenderParams(`?${RANGE}`)).toEqual({ start: START, end: END, ...RENDER_DEFAULTS });
	});

	it('reads size, quality and view', () => {
		const params = parseRenderParams(`?${RANGE}&frames=12&width=1200&height=630&quality=low&lat=-10&lon=120&alt=8000&tilt=30`);
		expect(params).toMatchObject({ frames: 12, width: 1200, height: 630, quality: 'low' });
		expect(params.view).toEqual({ lat: -10, lon: 120, altitude: 8000, tilt: 30 });
	});

	it.each([
		['missing start', 'end=2026-07-15T18:31:00Z'],
		['end before start', 'start=2026-07-15T18:31:00Z&end=2026-07-15T18:30:00Z'],
		['fractional frames', `${RANGE}&frames=2.5`],
		['zero width', `${RANGE}&width=0`],
		['oversized height', `${RANGE}&height=10000`],
		['latitude out of range', `${RANGE}&lat=91`],
		['unknown quality', `${RANGE}&quality=ultra`],
		['non-numeric altitude', `${RANGE}&alt=high`],
	])('rejects %s', (_, search) => {
		expect(() => parseRenderParams(search)).toThrow(RangeError);
	});
});

describe('frameTime', () => {
	const params = { start: START, end: END, frames: 30 };

	it('steps evenly from the start, the end excluded', () => {
		expect(frameTime(params, 0)).toBe(START);
		expect(frameTime(params, 1)).toBe(START + 2000);
		expect(frameTime(params, 29)).toBe(END - 2000);
	});

	it.each([-1, 30, 1.5])('rejects index %s', (index) => {
		expect(() => frameTime(params, index)).toThrow(RangeError);
	});
});
