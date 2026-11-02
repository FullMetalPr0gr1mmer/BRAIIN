import { z } from 'zod';
import { isCustomPageSlug } from '@schemas/customPages';
import { LocalizedTextSchema } from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import { latestInstant, parseRows, reportLoadError } from './parse';
import { contentClient } from './source';

// The published custom pages (Admin v2 E11), for the readers that LIST pages: the sitemap and
// llms.txt. Anon under RLS (pages_read: published only, the tenant fence), through the content
// seam, so a preview reads its own source. Only rows whose slug is a custom page's address are
// kept: the seven route pages are listed by their own routes, and a row no `[slug]` route would
// render is never offered to a crawler. Bounded (§4, the Free plan): 200 pages at most.
//
// `updatedAt` is when what the page shows last changed (Admin v2 E11 review E11-C2): a section
// edit never moves `pages.updated_at`, so each row embeds its visible sections' dates (anon
// reads only those, 0011; a plain embed, which the releases preview answers, where an ordered
// or limited one is refused) and the latest of them all is the sitemap's <lastmod>, the same
// rule as the page's own WebPage `dateModified` (getPageComposition's `modifiedAt`).

const CustomPageRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: LocalizedTextSchema,
  updated_at: z.string().nullable(),
  page_sections: z.array(z.object({ updated_at: z.string().nullable() })).nullish(),
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
      .select('id,slug,title,updated_at,page_sections(updated_at)')
      .eq('status', 'published')
      .order('slug', { ascending: true })
      .limit(CUSTOM_PAGES_LISTED);
    if (error) {
      reportLoadError('page', error);
      return [];
    }
    return parseRows(CustomPageRowSchema, data ?? [], 'page').flatMap((row) =>
      isCustomPageSlug(row.slug)
        ? [
            {
              id: row.id,
              slug: row.slug,
              title: row.title,
              updatedAt: latestInstant([
                row.updated_at,
                ...(row.page_sections ?? []).map((s) => s.updated_at),
              ]),
            },
          ]
        : [],
    );
  } catch (err) {
    reportLoadError('page', err);
    return [];
  }
}
