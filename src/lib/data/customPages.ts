import { z } from 'zod';
import { isCustomPageSlug } from '@schemas/customPages';
import { LocalizedTextSchema } from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import { parseRows, reportLoadError } from './parse';
import { contentClient } from './source';

// The published custom pages (Admin v2 E11), for the readers that LIST pages: the sitemap and
// llms.txt. Anon under RLS (pages_read: published only, the tenant fence), through the content
// seam, so a preview reads its own source. Only rows whose slug is a custom page's address are
// kept: the seven route pages are listed by their own routes, and a row no `[slug]` route would
// render is never offered to a crawler. Bounded (§4, the Free plan): 200 pages at most.

const CustomPageRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: LocalizedTextSchema,
  updated_at: z.string().nullable(),
});

export interface PublishedCustomPage {
  id: string;
  slug: string;
  title: { en: string; ar: string };
  updatedAt: string | null;
}

/** The most custom pages a listing offers. */
export const CUSTOM_PAGES_LISTED = 200;

/** Every published custom page, by slug; [] when the read fails (reported) or is unconfigured. */
export async function getPublishedCustomPages(): Promise<PublishedCustomPage[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('pages')
      .select('id,slug,title,updated_at')
      .eq('status', 'published')
      .order('slug', { ascending: true })
      .limit(CUSTOM_PAGES_LISTED);
    if (error) {
      reportLoadError('page', error);
      return [];
    }
    return parseRows(CustomPageRowSchema, data ?? [], 'page').flatMap((row) =>
      isCustomPageSlug(row.slug)
        ? [{ id: row.id, slug: row.slug, title: row.title, updatedAt: row.updated_at }]
        : [],
    );
  } catch (err) {
    reportLoadError('page', err);
    return [];
  }
}
