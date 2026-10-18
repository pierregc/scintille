import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { searchCatalog, type SearchBucket, type SearchCache } from '../../../storms/search-store';
import { BUILD } from '../../../version';
import type { StormSearchResponse } from '../../../contract/types';
import { boundedBody } from '../../../globe/clouds/response';
import { hash } from '../../../storms/search-query';
import { SearchError } from '../../../storms/search-query';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
	const metrics = { reads: 0, bytes: 0, candidates: 0 };
	try {
		const bucket = (env as unknown as { LIVE: SearchBucket }).LIVE;
		const edge = import.meta.env.DEV ? undefined : (caches as CacheStorage & { default?: Cache }).default;
		const key = async (value: string) => new Request(new URL(`/__storm-search-cache/${BUILD.commit ?? 'dev'}/${await hash(value)}`, url));
		const cache: SearchCache | undefined = edge ? {
			async get(value) {
				const hit = await edge.match(await key(value));
				return hit ? JSON.parse(new TextDecoder().decode(await boundedBody(hit, 65536))) as StormSearchResponse : null;
			},
			async put(value, result) {
				await edge.put(await key(value), Response.json(result, { headers: { 'Cache-Control': 'public, max-age=300' } }));
			},
		} : undefined;
		const result = await searchCatalog(bucket, url.searchParams, Date.now(), metrics, cache);
		const cursor = url.searchParams.get('cursor') ?? result.next_cursor;
		const expires = cursor ? Number((JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as { expires: number }).expires) : Date.now() + 60000;
		const maxAge = Math.max(0, Math.min(60, Math.floor((expires - Date.now()) / 1000)));
		return Response.json(result, { headers: {
			'Cache-Control': `public, max-age=${maxAge}`,
			'Server-Timing': `r2;desc="${metrics.reads} reads / ${metrics.bytes} bytes", candidates;desc="${metrics.candidates}"`,
		} });
	} catch (error) {
		const status = error instanceof SearchError ? error.status : 503;
		if (status === 503) console.warn('storm search:', error);
		return Response.json({ error: error instanceof SearchError ? error.message : 'The storm catalog is unavailable. Try again.' }, { status, headers: { 'Cache-Control': 'no-store' } });
	}
};
