import { PageSectionRowSchema, SECTION_CONTENT_SCHEMAS } from '@schemas/sections';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import type { SectionData } from '@/lib/sections/types';
import { parseRows } from './parse';

// Public Tier-A read of CMS-authored page compositions (`pages` + `page_sections`,
// authored at /admin/pages and /admin/sections). This is what makes the section engine
// actually CMS-driven: order = sort_order, toggling = visible, per-instance copy =
// content jsonb (validated per type — see packages/schemas/sections.ts).
//
// Returns null (caller falls back to the DEFAULT_* composition in lib/sections/types)
// when Supabase is unconfigured/unreachable, the page isn't published, or it has no
// sections yet — the site never renders empty because authoring hasn't happened.

export async function getPageSections(pageSlug: string): Promise<SectionData[] | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data: page, error: pageError } = await anonClient()
      .from('pages')
      .select('id')
      .eq('slug', pageSlug)
      .eq('status', 'published')
      .maybeSingle();
    if (pageError || !page) return null;

    const { data, error } = await anonClient()
      .from('page_sections')
      .select('type,content,visible,sort_order')
      .eq('page_id', page.id)
      .order('sort_order', { ascending: true });
    if (error || !data || data.length === 0) return null;

    const rows = parseRows(PageSectionRowSchema, data, 'page_section');
    if (rows.length === 0) return null;

    return rows.map((row) => {
      // Content is validated against the section's type; invalid JSON degrades to the
      // component's built-in copy rather than breaking render (SectionBoundary is the
      // second net). Unknown types pass through — SectionRenderer skips them.
      const schema = SECTION_CONTENT_SCHEMAS[row.type];
      const parsed = schema?.safeParse(row.content);
      return {
        type: row.type,
        visible: row.visible,
        props: parsed?.success ? (parsed.data as Record<string, unknown>) : {},
      };
    });
  } catch {
    return null;
  }
}
