import type { SupabaseClient } from '@supabase/supabase-js';

// Where a page's own button text wins over the forms config's (Admin v2 E8, review finding CR3).
// The inquiry band (`contactInquiry`, the Contact page) may carry its own `submitLabel`, set in
// Pages, and ContactForm.astro shows it before the config's button (the section's, then the
// config's, then the built-in; which should win is owner question 2 in the as-built note). So the
// Forms editor names each page whose shown inquiry band sets one, beside the button it edits,
// instead of letting a save there change nothing on that page without a word.
//
// Read under the person's RLS (Admin and Developer, the Forms screen's roles, read every
// section of their tenant); the live rows, as a visitor sees them. Best effort: a failed read
// gives no note, never a failed page.

/** The section types that wrap the inquiry form and may set its button (sections.ts). */
export const BUTTON_SECTION_TYPES = ['contactInquiry'] as const;

/** One page whose own button text replaces the forms config's there. */
export interface PageButton {
  /** The page's English title (its slug when it has none). */
  page: string;
  en: string;
  ar: string;
}

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A page's English title (`pages.title` is bilingual jsonb), else its slug. */
const titleOf = (page: Row): string => {
  const title = page['title'];
  const en = title && typeof title === 'object' ? text((title as Row)['en']) : text(title);
  return en || text(page['slug']);
};

/**
 * The pages a set of section rows sets a button for: a shown section with a stored
 * `submitLabel` in either language, named by its page, each page once, in the pages' order.
 */
export function pageButtonsFrom(sections: readonly Row[], pages: readonly Row[]): PageButton[] {
  const out: PageButton[] = [];
  for (const page of pages) {
    const own = sections.find((s) => {
      if (s['page_id'] !== page['id'] || s['visible'] === false) return false;
      const label = s['submit'];
      return (
        !!label &&
        typeof label === 'object' &&
        (text((label as Row)['en']) !== '' || text((label as Row)['ar']) !== '')
      );
    });
    if (!own) continue;
    const label = own['submit'] as Row;
    out.push({
      page: titleOf(page),
      en: text(label['en']),
      ar: text(label['ar']),
    });
  }
  return out;
}

/** The pages of this tenant whose inquiry band sets its own button text. Never throws. */
export async function loadPageButtons(sb: SupabaseClient, tenantId: string): Promise<PageButton[]> {
  try {
    const { data: sections, error } = await sb
      .from('page_sections')
      .select('page_id,visible,submit:content->submitLabel')
      .eq('tenant_id', tenantId)
      .in('type', [...BUTTON_SECTION_TYPES])
      .limit(50);
    if (error || !sections || sections.length === 0) return [];
    const ids = [...new Set((sections as Row[]).map((s) => s['page_id']))];
    const { data: pages, error: pagesError } = await sb
      .from('pages')
      .select('id,slug,title')
      .eq('tenant_id', tenantId)
      .in('id', ids)
      .order('slug', { ascending: true });
    if (pagesError || !pages) return [];
    return pageButtonsFrom(sections as Row[], pages as Row[]);
  } catch {
    return [];
  }
}
