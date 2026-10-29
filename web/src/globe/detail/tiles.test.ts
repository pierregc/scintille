import { describe, expect, it } from 'vitest';
import { TileLoadError } from './loader';
import type { PyramidManifest } from './pyramid';
import { imageSource, type TileImage } from './tiles';

const manifest: PyramidManifest = { version: 3, path: '{layer}/{z}/{x}-{y}.webp', tileTexels: 450, border: 1, maxLevel: 5, levels: {} };

function sourceFor(response: () => Promise<Response>) {
	const urls: string[] = [];
	const fetcher = ((url: string) => {
		urls.push(url);
		return response();
	}) as typeof fetch;
	return { urls, source: imageSource('https://data.example/textures/v3', manifest, fetcher) };
}

const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) => (error instanceof TileLoadError ? error.failure : error),
	);

describe('imageSource', () => {
	it('fetches the path from the manifest template', async () => {
		const { urls, source } = sourceFor(async () => new Response(null, { status: 404 }));
		await failure(source.load('night', { z: 4, x: 30, y: 12 }, new AbortController().signal));
		expect(urls).toEqual(['https://data.example/textures/v3/night/4/30-12.webp']);
	});

	it.each([403, 404, 410])('gives up on %i', async (status) => {
		const { source } = sourceFor(async () => new Response(null, { status }));
		expect(await failure(source.load('day', { z: 5, x: 1, y: 1 }, new AbortController().signal))).toEqual({ kind: 'missing' });
	});

	it('retries later on server errors', async () => {
		const { source } = sourceFor(async () => new Response(null, { status: 503 }));
		expect(await failure(source.load('day', { z: 5, x: 1, y: 1 }, new AbortController().signal))).toEqual({ kind: 'retry' });
	});

	it('follows Retry-After when throttled', async () => {
		const { source } = sourceFor(async () => new Response(null, { status: 429, headers: { 'retry-after': '5' } }));
		expect(await failure(source.load('day', { z: 5, x: 1, y: 1 }, new AbortController().signal))).toEqual({ kind: 'throttled', retryAfterMs: 5000 });
	});

	it('passes network errors on, for the loader to retry', async () => {
		const { source } = sourceFor(() => Promise.reject(new TypeError('Failed to fetch')));
		expect(await failure(source.load('day', { z: 5, x: 1, y: 1 }, new AbortController().signal))).toBeInstanceOf(TypeError);
	});

	it('closes the bitmap and frees the layer of a disposed tile', () => {
		const released: TileImage[] = [];
		const source = imageSource('https://data.example/textures/v3', manifest, fetch, (image) => released.push({ ...image }));
		let closed = 0;
		const image: TileImage = { bitmap: { close: () => closed++ } as unknown as ImageBitmap, layer: 12 };
		source.dispose(image);
		expect(closed).toBe(1);
		expect(image.bitmap).toBeNull();
		expect(released).toEqual([{ bitmap: null, layer: 12 }]);
	});
});
