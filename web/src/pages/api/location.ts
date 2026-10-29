import type { APIRoute } from 'astro';
import { SCHEMA_VERSION } from '../../contract/types';
import { approximateLocation, type IpGeo, PRIVATE_HEADERS } from '../../search/location';

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
	const cf = (request as Request & { cf?: IpGeo }).cf;
	return new Response(JSON.stringify({ schema_version: SCHEMA_VERSION, ...approximateLocation(cf) }), { headers: PRIVATE_HEADERS });
};
