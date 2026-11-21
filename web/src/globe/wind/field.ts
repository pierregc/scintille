import { ClampToEdgeWrapping, LinearFilter, NoColorSpace, RepeatWrapping, RGFormat, Texture } from 'three';
import { WIND_RULES } from '../../contract/wind';
import { boundedBody } from '../clouds/response';
import type { WindSource } from './manifest';
import type { WindField } from './types';

/**
 * Downloads one wind texture and keeps its bytes exact: no colour conversion, no premultiplied alpha,
 * no mipmaps, only red (u) and green (v) on the GPU. North is at v = 1, as with the cloud maps.
 */
export async function loadWindField(source: Pick<WindSource, 'url' | 'time' | 'level' | 'scaleMs'>, signal?: AbortSignal): Promise<WindField> {
	const response = await fetch(source.url, { signal });
	if (!response.ok) throw new Error('wind texture unavailable');
	const bytes = await boundedBody(response, WIND_RULES.max_frame_bytes);
	signal?.throwIfAborted();
	const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), {
		imageOrientation: 'flipY',
		premultiplyAlpha: 'none',
		colorSpaceConversion: 'none',
	});
	if (signal?.aborted || bitmap.width !== WIND_RULES.width || bitmap.height !== WIND_RULES.height) {
		bitmap.close();
		signal?.throwIfAborted();
		throw new Error('wind texture has the wrong size');
	}
	const texture = new Texture(bitmap, undefined, RepeatWrapping, ClampToEdgeWrapping, LinearFilter, LinearFilter, RGFormat);
	texture.colorSpace = NoColorSpace;
	texture.generateMipmaps = false;
	texture.flipY = false;
	texture.premultiplyAlpha = false;
	texture.needsUpdate = true;
	texture.addEventListener('dispose', () => bitmap.close());
	return { time: source.time, level: source.level, texture, scaleMs: source.scaleMs };
}
