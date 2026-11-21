import { LinearFilter, NoColorSpace, RepeatWrapping, RGFormat } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WIND_RULES } from '../../contract/wind';
import { loadWindField } from './field';

const SOURCE = { url: 'https://data.example/archive/wind/10m/2026/11/21/20261121T13Z-1a2b3c4d.webp', time: 7, level: '10m', scaleMs: 40 } as const;

function fakeBitmap(width: number = WIND_RULES.width, height: number = WIND_RULES.height) {
	return { width, height, close: vi.fn() };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('loadWindField', () => {
	it('decodes the bytes untouched into a two channel texture without mipmaps', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('webp')));
		const bitmap = fakeBitmap();
		const decode = vi.fn().mockResolvedValue(bitmap);
		vi.stubGlobal('createImageBitmap', decode);
		const field = await loadWindField(SOURCE);
		expect(decode.mock.calls[0][1]).toEqual({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
		expect(field).toMatchObject({ time: 7, level: '10m', scaleMs: 40 });
		const t = field.texture;
		expect([t.image, t.format, t.colorSpace, t.generateMipmaps, t.minFilter, t.magFilter, t.flipY, t.premultiplyAlpha, t.wrapS])
			.toEqual([bitmap, RGFormat, NoColorSpace, false, LinearFilter, LinearFilter, false, false, RepeatWrapping]);
		expect(bitmap.close).not.toHaveBeenCalled();
		t.dispose();
		expect(bitmap.close).toHaveBeenCalledOnce();
	});

	it('refuses an oversized download before decoding it', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {
			headers: { 'Content-Length': String(WIND_RULES.max_frame_bytes + 1) },
		})));
		const decode = vi.fn();
		vi.stubGlobal('createImageBitmap', decode);
		await expect(loadWindField(SOURCE)).rejects.toThrow('too large');
		expect(decode).not.toHaveBeenCalled();
	});

	it('refuses an image of the wrong size and frees it', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('webp')));
		const bitmap = fakeBitmap(1440, 721);
		vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
		await expect(loadWindField(SOURCE)).rejects.toThrow('wrong size');
		expect(bitmap.close).toHaveBeenCalledOnce();
	});

	it('stops when aborted', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('webp')));
		const request = new AbortController();
		const bitmap = fakeBitmap();
		vi.stubGlobal('createImageBitmap', vi.fn(async () => { request.abort(); return bitmap; }));
		await expect(loadWindField(SOURCE, request.signal)).rejects.toThrow();
		expect(bitmap.close).toHaveBeenCalledOnce();
	});
});
