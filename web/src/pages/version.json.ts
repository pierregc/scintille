import type { APIRoute } from 'astro';
import { BUILD } from '../version';

export const prerender = true;

export const GET: APIRoute = () => Response.json(BUILD);
