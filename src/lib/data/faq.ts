import type { Locale } from '@schemas/primitives';
import { FaqItemRowSchema, type FaqEntry } from '@schemas/faq';
import { supabaseConfigured } from '@/lib/supabase/client';
import { parseRows, reportLoadError } from './parse';
import { contentClient } from './source';

// The FAQ (Admin v2 U7, migration 0098): the ONE loader behind two things that must never
// disagree, the Contact page's FAQ band (FaqAccordion.astro, handed these rows as route
// data) and the FAQPage JSON-LD in its head (src/lib/sections/contactPage.ts builds it from the SAME
// array). Structured data that describes questions the page does not visibly contain is a
// manual-action category, so the route loads this once and hands the one result to both.
//
// Published rows only (anon's RLS, tenant-fenced; its column grant is id, question, answer,
// sort_order and status), in the editors' order, at most 50. There is no code copy to fall
// back on: a failed read logs its code and answers [], and an empty FAQ hides the band AND
// omits the FAQPage, never one without the other (a copy in code would drift from what
// editors publish: a withdrawn answer would reappear in an outage).
//
// Answers are written answer-first (the GEO authoring default, CLAUDE.md Pillar 3): the
// direct answer in the first sentence, the qualification after.

export type { FaqEntry } from '@schemas/faq';

const COLUMNS = 'id,question,answer,sort_order';
/** The most questions one page shows (and one FAQPage lists). */
export const FAQ_MAX_ITEMS = 50;

export async function getFaq(locale: Locale): Promise<FaqEntry[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('faq_items')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(FAQ_MAX_ITEMS);
    if (error) {
      reportLoadError('faq_items', error);
      return [];
    }
    return parseRows(FaqItemRowSchema, data ?? [], 'faq_item').map((row) => ({
      question: row.question[locale],
      answer: row.answer[locale],
    }));
  } catch (err) {
    reportLoadError('faq_items', err);
    return [];
  }
}
