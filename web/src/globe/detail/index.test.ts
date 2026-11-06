import { describe, expect, it } from 'vitest';
import { surfaceFromSearch } from '.';

describe('surfaceFromSearch', () => {
	it('draws the tiles unless asked otherwise', () => {
		expect(surfaceFromSearch('')).toEqual({ mode: 'tiles', texelPixels: 2 });
		expect(surfaceFromSearch('?surface=unknown&texel=-1')).toEqual({ mode: 'tiles', texelPixels: 2 });
	});

	it('switches to the base textures, with a threshold', () => {
		expect(surfaceFromSearch('?surface=base')).toEqual({ mode: 'base', texelPixels: 2 });
		expect(surfaceFromSearch('?surface=base&texel=4')).toEqual({ mode: 'base', texelPixels: 4 });
	});
});
