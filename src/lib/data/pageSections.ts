import { z } from 'zod';
import {
  PageSectionRowSchema,
  SECTION_CONTENT_SCHEMAS,
  SECTION_TYPES,
  type SectionType,
} from '@schemas/sections';
import { LocalizedTextSchema } from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import type { SectionData } from '@/lib/sections/types';
import { parseRow, parseRows, reportLoadError } from './parse';
import { contentClient } from './source';
import { serviceClient } from '@/lib/supabase/server';
import { pageAccess } from '@/lib/visibility/scope';

// Public Tier-A read of CMS-authored page compositions (`pages` + `page_sections`,
// authored at /admin/pages and /admin/sections). This is what makes the section engine
// actually CMS-driven: order = sort_order, toggling = visible, per-instance copy =
// content jsonb (validated per type — see packages/schemas/sections.ts).
//
// Anonymous reads of page_sections exist since migration 0016; before it, every call here
// hit 42501 and fell back — which is why nothing composed in the CMS had ever reached a
// visitor. The 0011 restrictive policy is the fence: visible sections of PUBLISHED pages.
//
// THE ONE SERVICE-ROLE READ BEHIND THIS SEAM (Admin v2 U14b). A page behind a password is
// fenced from anon in the database (page_sections_password_fence, 0061), so the anon read
// above returns none of its sections — by design, and so that the edge gate failing open
// leaks nothing. A visitor who HAS typed the password is served by the middleware inside
// `withPageAccess`, and only then, and only for that one page, does this loader read the
// sections through `public.page_sections_unlocked` as the service role. That function
// returns exactly the rows and columns anon would have read without the fence (a visible
// section of a published page; type, content, visible, sort_order), so an unlocked page
// renders what a public one would and nothing more. The scope is read BEFORE any query is
// awaited: workerd does not carry an AsyncLocalStorage scope into a thenable's then(), and
// a supabase-js builder is a thenable (src/lib/data/source.ts has the whole rule).
// tests/lib/contentSource.spec.ts pins this read, by file and by reason.
//
// getPageComposition returns:
//   null                    Supabase unconfigured/unreachable, or the page is not published
//   { page, sections: [] }  published but not yet composed (or its sections failed to load)
//   { page, sections }      the authored composition
// The page is returned even with no sections because its id keys the page's own SEO
// override (`entity_seo`): a published page must be able to carry a title override
// before anyone has composed it. Callers fall back to the DEFAULT_* composition in
// lib/sections/types on an EMPTY list — the site never renders empty because authoring
// hasn't happened.

const PageRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: LocalizedTextSchema,
  updated_at: z.string().nullable(),
});

export interface PageComposition {
  /** The page row — `id` keys the page's SEO override (`loadHead`, entity type 'page'). */
  page: { id: string; slug: string; title: { en: string; ar: string }; updatedAt: string | null };
  sections: SectionData[];
}

const KNOWN = new Set<string>(SECTION_TYPES);
const isSectionType = (t: string): t is SectionType => KNOWN.has(t);

function toSection(row: z.infer<typeof PageSectionRowSchema>): SectionData | null {
  // A type the renderer does not know would be skipped at render anyway; dropping it here
  // keeps the composition honest and logs it.
  if (!isSectionType(row.type)) {
    console.warn(`[content] page_section with unknown type '${row.type}' skipped`);
    return null;
  }
  const schema = SECTION_CONTENT_SCHEMAS[row.type];
  // Table-backed types (statistics, team, certifications) take NO content props: their
  // data comes from their own tables, and a stray key would overwrite it (the write path
  // refuses one too — sectionContentIssues).
  if (!schema) return { type: row.type, visible: row.visible, props: {} };
  // Invalid JSON degrades to the component's built-in copy rather than breaking render
  // (SectionBoundary is the second net).
  const parsed = schema.safeParse(row.content);
  return {
    type: row.type,
    visible: row.visible,
    props: parsed.success ? (parsed.data as Record<string, unknown>) : {},
  };
}

export async function getPageComposition(pageSlug: string): Promise<PageComposition | null> {
  if (!supabaseConfigured()) return null;
  // Read first, before any query is awaited (see the note above).
  const access = pageAccess();
  try {
    const { data: pageData, error: pageError } = await contentClient()
      .from('pages')
      .select('id,slug,title,updated_at')
      .eq('slug', pageSlug)
      .eq('status', 'published')
      .maybeSingle();
    if (pageError) {
      reportLoadError('page', pageError);
      return null;
    }
    const page = pageData ? parseRow(PageRowSchema, pageData, 'page') : null;
    if (!page) return null;
    const pageRef = { id: page.id, slug: page.slug, title: page.title, updatedAt: page.updated_at };

    const unlocked =
      access !== undefined && access.pageId === page.id && access.tenantId.length > 0
        ? access
        : null;
    const { data, error } =
      unlocked === null
        ? await contentClient()
            .from('page_sections')
            .select('type,content,visible,sort_order')
            .eq('page_id', page.id)
            .order('sort_order', { ascending: true })
        : await serviceClient().rpc('page_sections_unlocked', {
            p_tenant: unlocked.tenantId,
            p_page_id: page.id,
          });
    if (error) {
      reportLoadError('page_section', error);
      return { page: pageRef, sections: [] };
    }

    const sections = parseRows(PageSectionRowSchema, data ?? [], 'page_section').flatMap((row) => {
      const section = toSection(row);
      return section ? [section] : [];
    });
    return { page: pageRef, sections };
  } catch (err) {
    reportLoadError('page_section', err);
    return null;
  }
}

/** Sections only — for routes that need no page-level metadata. Null until composed. */
export async function getPageSections(pageSlug: string): Promise<SectionData[] | null> {
  const composition = await getPageComposition(pageSlug);
  return composition && composition.sections.length > 0 ? composition.sections : null;
}
