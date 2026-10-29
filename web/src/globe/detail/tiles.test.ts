import { describe, expect, it } from 'vitest';
import { TileLoadError } from './loader';
import type { PyramidManifest } from './pyramid';
import { textureSource } from './tiles';

const manifest: PyramidManifest = { version: 3, path: '{layer}/{z}/{x}-{y}.webp', tileTexels: 450, border: 1, maxLevel: 5, levels: {} };

function sourceFor(response: () => Promise<Response>) {
	const urls: string[] = [];
	const fetcher = ((url: string) => {
		urls.push(url);
		return response();
	}) as typeof fetch;
	return { urls, source: textureSource('https://data.example/textures/v3', manifest, 1, fetcher) };
}

const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) => (error instanceof TileLoadError ? error.failure : error),
	);

describe('textureSource', () => {
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
});
