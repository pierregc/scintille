import { expect, it } from 'vitest';
import { parseLevels } from './levels';

it('keeps only valid saved levels', () => {
	expect(parseLevels(null)).toEqual({});
	expect(parseLevels('not json')).toEqual({});
	expect(parseLevels('{"music":0,"flashes":0.5}')).toEqual({ music: 0, flashes: 0.5 });
	expect(parseLevels('{"music":2,"flashes":"loud"}')).toEqual({});
	expect(parseLevels('[0.2]')).toEqual({});
});
