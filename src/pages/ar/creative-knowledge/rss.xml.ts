import type { APIRoute } from 'astro';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { buildRssFeed } from '@/lib/seo/rss';
import { getIdentity, brandName } from '@/lib/identity';

// RSS 2.0 for the Creative Knowledge blog (AR) — the twin of
// /creative-knowledge/rss.xml. CLAUDE.md §8: both languages are built, always.
export const prerender = false;

export const GET: APIRoute = async ({ locals }) =>
  buildRssFeed('ar', PUBLIC_SITE_URL, brandName(await getIdentity(locals), 'ar'));
