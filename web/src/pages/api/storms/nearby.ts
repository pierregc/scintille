import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleNearby } from '../../../search/search';
import { BUILD } from '../../../version';

export const prerender = false;

export const GET: APIRoute = ({ request }) =>
	handleNearby(new URL(request.url), env.SEARCH, Math.floor(Date.now() / 1000), BUILD.commit ?? 'dev', typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default);
