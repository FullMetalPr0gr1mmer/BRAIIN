import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { buildRssFeed } from '@/lib/seo/rss';
import { getIdentity, brandName } from '@/lib/identity';

// RSS 2.0 for the Creative Knowledge blog (EN). The Arabic twin lives at
// /ar/creative-knowledge/rss.xml and shares this builder.
export const prerender = false;

export const GET: APIRoute = async ({ locals }) =>
  buildRssFeed('en', PUBLIC_SITE_URL, brandName(await getIdentity(locals), 'en'));
