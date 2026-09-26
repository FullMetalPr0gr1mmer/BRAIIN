import { z } from 'zod';
import {
  PageSectionRowSchema,
  SECTION_CONTENT_SCHEMAS,
  SECTION_TYPES,
  type SectionType,
} from '@schemas/sections';
import { LocalizedTextSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import type { SectionData } from '@/lib/sections/types';
import { parseRow, parseRows, reportLoadError } from './parse';

// Public Tier-A read of CMS-authored page compositions (`pages` + `page_sections`,
// authored at /admin/pages and /admin/sections). This is what makes the section engine
// actually CMS-driven: order = sort_order, toggling = visible, per-instance copy =
// content jsonb (validated per type — see packages/schemas/sections.ts).
//
// Anonymous reads of page_sections exist since migration 0016; before it, every call here
// hit 42501 and fell back — which is why nothing composed in the CMS had ever reached a
// visitor. The 0011 restrictive policy is the fence: visible sections of PUBLISHED pages.
//
// Returns null (caller falls back to the DEFAULT_* composition in lib/sections/types)
// when Supabase is unconfigured/unreachable, the page isn't published, or it has no
// sections yet — the site never renders empty because authoring hasn't happened.

const PageRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: LocalizedTextSchema,
  updated_at: z.string().nullable(),
});

export interface PageComposition {
  /** The page row — `id` keys per-page SEO overrides (`seoForEntity('page', id)`). */
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
  try {
    const { data: pageData, error: pageError } = await anonClient()
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

    const { data, error } = await anonClient()
      .from('page_sections')
      .select('type,content,visible,sort_order')
      .eq('page_id', page.id)
      .order('sort_order', { ascending: true });
    if (error) {
      reportLoadError('page_section', error);
      return null;
    }
    if (!data || data.length === 0) return null;

    const sections = parseRows(PageSectionRowSchema, data, 'page_section').flatMap((row) => {
      const section = toSection(row);
      return section ? [section] : [];
    });
    if (sections.length === 0) return null;

    return {
      page: { id: page.id, slug: page.slug, title: page.title, updatedAt: page.updated_at },
      sections,
    };
  } catch (err) {
    reportLoadError('page_section', err);
    return null;
  }
}

/** Sections only — for routes that need no page-level metadata. */
export async function getPageSections(pageSlug: string): Promise<SectionData[] | null> {
  return (await getPageComposition(pageSlug))?.sections ?? null;
}
