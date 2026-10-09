import { describe, expect, it } from 'vitest';
import { texturesRoot, texturesUrl } from './earth';

describe('texturesRoot', () => {
	it('serves public/textures in dev and R2 in production', () => {
		expect(texturesRoot(undefined, true)).toBe('/textures');
		expect(texturesRoot(undefined, false)).toBe('https://data.scintille.app/textures/v1');
	});

	it('prefers PUBLIC_TEXTURES_URL without its trailing slash', () => {
		expect(texturesRoot('https://cdn.example/t/', false)).toBe('https://cdn.example/t');
		expect(texturesRoot('', false)).toBe('https://data.scintille.app/textures/v1');
	});
});

describe('texturesUrl', () => {
	it('points at the 4k WebP tier', () => {
		expect(texturesUrl('night', '/textures')).toBe('/textures/4k/night.webp');
	});
});
