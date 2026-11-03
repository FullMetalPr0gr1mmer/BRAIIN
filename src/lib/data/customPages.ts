import { z } from 'zod';
import { ROUTE_PAGE_SLUGS, isCustomPageSectionType, isCustomPageSlug } from '@schemas/customPages';
import { LocalizedTextSchema } from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import { latestInstant, parseRows, reportLoadError } from './parse';
import { contentClient } from './source';

// The published custom pages (Admin v2 E11), for the readers that LIST pages: the sitemap and
// llms.txt. Anon under RLS (pages_read: published only, the tenant fence), through the content
// seam, so a preview reads its own source. Only rows whose slug is a custom page's address are
// kept: the seven route pages are listed by their own routes, and a row no `[slug]` route would
// render is never offered to a crawler. Bounded (§4, the Free plan): 200 custom pages at most,
// the first by address (E11 code review, CR7): the read takes 200 more than the seven route
// pages, ordered by slug and id, so the route pages it then drops never cost a custom page its
// place. (A `not in` filter would say it in the query, but the releases preview's emulator
// answers only eq, in, contains, order and limit, src/lib/preview/client.ts; and getSeoRules'
// read of every published page is id and slug only, for indexability, so it is not reused.)
//
// `updatedAt` is when what the page shows last changed (Admin v2 E11 review E11-C2): a section
// edit never moves `pages.updated_at`, so each row embeds its visible sections' types and dates
// (anon reads only those, 0011; a plain embed, which the releases preview answers, where an
// ordered or limited one is refused) and the latest of the row and the sections the page
// renders (the custom set, code review CR6) is the sitemap's <lastmod>, the same rule as the
// page's own WebPage `dateModified` (customModifiedAt, src/lib/sections/customPage.ts).

const CustomPageRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: LocalizedTextSchema,
  updated_at: z.string().nullable(),
  page_sections: z
    .array(z.object({ type: z.string(), updated_at: z.string().nullable() }))
    .nullish(),
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
      .select('id,slug,title,updated_at,page_sections(type,updated_at)')
      .eq('status', 'published')
      .order('slug', { ascending: true })
      .order('id', { ascending: true })
      .limit(CUSTOM_PAGES_LISTED + ROUTE_PAGE_SLUGS.length);
    if (error) {
      reportLoadError('page', error);
      return [];
    }
    return parseRows(CustomPageRowSchema, data ?? [], 'page')
      .flatMap((row) =>
        isCustomPageSlug(row.slug)
          ? [
              {
                id: row.id,
                slug: row.slug,
                title: row.title,
                updatedAt: latestInstant([
                  row.updated_at,
                  ...(row.page_sections ?? [])
                    .filter((s) => isCustomPageSectionType(s.type))
                    .map((s) => s.updated_at),
                ]),
              },
            ]
          : [],
      )
      .slice(0, CUSTOM_PAGES_LISTED);
  } catch (err) {
    reportLoadError('page', err);
    return [];
  }
}
