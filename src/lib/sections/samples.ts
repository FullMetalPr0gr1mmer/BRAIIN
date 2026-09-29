import type { StatRating } from '@schemas/sections';

// Design-delivery sample values the admin must never let go live as real content
// (Round 3, item D). Refusal-only: nothing here is rendered — a page renders what its
// row stores, and the seed (supabase/seed-data/54-services-page.json) is asserted equal
// to this constant by tests/lib/servicesPage.spec.ts so the two cannot drift apart.
//
// Why the app needs this at all: the Services proof band's rating line lives INSIDE
// `page_sections.content`, so the row-level placeholder machinery (0025's guard, the
// admin's `refusePlaceholder`) sees only the section's flag. Unticking "Placeholder" on
// that section with the sample "4.9 / 5" still stored would publish a rating no review
// data backs, unflagged. `sectionResource.assertWritable` refuses exactly that.

/** The mockup's rating line, as seeded on the Services page's proof band. */
export const SERVICES_PROOF_SAMPLE_RATING: Readonly<StatRating> = Object.freeze({
  value: '4.9 / 5',
  label: Object.freeze({ en: 'average client rating', ar: 'متوسط تقييم عملائنا' }),
});

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/**
 * Whether a stored rating is (still) the design sample. The value alone decides — the
 * label re-worded around the sample number is the same unbacked claim — and whitespace
 * or case is not a real edit.
 */
export function isSampleRating(rating: unknown): boolean {
  if (!rating || typeof rating !== 'object' || Array.isArray(rating)) return false;
  const value = norm((rating as Record<string, unknown>)['value']);
  return value !== '' && value.replace(/\s+/g, '') === '4.9/5';
}
