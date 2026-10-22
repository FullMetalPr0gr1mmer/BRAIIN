import type { APIRoute } from 'astro';
import { manifestResponse } from '@/lib/seo/manifest';

// The web app manifest in English (Admin v2 U9): src/lib/seo/manifest.ts.
export const prerender = false;

export const GET: APIRoute = (context) => manifestResponse(context, 'en');
