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
const normValue = (s: unknown): string => norm(s).replace(/\s+/g, '');

const SAMPLE_VALUE = normValue(SERVICES_PROOF_SAMPLE_RATING.value);
const SAMPLE_LABEL = {
  en: norm(SERVICES_PROOF_SAMPLE_RATING.label.en),
  ar: norm(SERVICES_PROOF_SAMPLE_RATING.label.ar),
};

/**
 * Whether a stored rating is (still) the design sample: the sample's VALUE under the
 * sample's LABEL — in either language, since a half-translated claim is still the
 * claim — or under no label at all (missing, blank or malformed: nothing backs the
 * number). A genuine "4.9 / 5" is told apart by its label: a real, sourced label under
 * the same number passes. Whitespace or case is not a real edit, in either part.
 */
export function isSampleRating(rating: unknown): boolean {
  if (!rating || typeof rating !== 'object' || Array.isArray(rating)) return false;
  const r = rating as Record<string, unknown>;
  const value = normValue(r['value']);
  if (value === '' || value !== SAMPLE_VALUE) return false;
  const label = r['label'];
  const halves =
    label && typeof label === 'object' && !Array.isArray(label)
      ? (label as Record<string, unknown>)
      : {};
  const en = norm(halves['en']);
  const ar = norm(halves['ar']);
  if (en === '' && ar === '') return true;
  return en === SAMPLE_LABEL.en || ar === SAMPLE_LABEL.ar;
}
