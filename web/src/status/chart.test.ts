import { describe, expect, it } from 'vitest';
import { indexAt, niceMax, paths, point } from './chart';

const frame = { width: 590, height: 64, max: 100 };

describe('niceMax', () => {
	it('rounds up to a round number', () => {
		expect([0, 1, 3, 7, 12, 2116, 5000].map(niceMax)).toEqual([1, 1, 3, 8, 15, 2500, 5000]);
	});
});

describe('point', () => {
	it('right-aligns a short series on the hour', () => {
		expect(point(0, 0, 60, frame)).toEqual([0, 64]);
		expect(point(59, 100, 60, frame)).toEqual([590, 0]);
		expect(point(0, 50, 2, frame)).toEqual([580, 32]);
	});
});

describe('paths', () => {
	it('splits the minute in progress from complete minutes', () => {
		expect(paths([0, 100, 50], { ...frame, width: 59 })).toEqual({ done: 'M57 64L58 0', current: 'M58 0L59 32' });
		expect(paths([], frame)).toEqual({ done: '', current: '' });
	});
});

describe('indexAt', () => {
	it('maps a position to the nearest minute of the series', () => {
		expect(indexAt(590, 60, 590)).toBe(59);
		expect(indexAt(0, 60, 590)).toBe(0);
		expect(indexAt(0, 10, 590)).toBeNull();
		expect(indexAt(590, 10, 590)).toBe(9);
		expect(indexAt(10, 0, 590)).toBeNull();
	});
});
