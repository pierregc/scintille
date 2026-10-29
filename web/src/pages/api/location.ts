import type { APIRoute } from 'astro';
import { approximateLocation, type IpGeo, PRIVATE_HEADERS } from '../../search/location';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
	const cf = (request as Request & { cf?: IpGeo }).cf;
	return new Response(JSON.stringify(approximateLocation(cf)), { headers: PRIVATE_HEADERS });
};
