import { customPageSlugProblem, isRoutePageSlug } from '@schemas/customPages';

// The New page dialog's rules (Admin v2 E11), pure: the island and tests/lib/newPage.spec.ts
// both read them. The server holds every one of them too (PageWriteSchema, 0123's trigger, the
// unique key, SectionWriteSchema's hero headline rule); these only say a refusal before a
// round trip, in the same words.

/** A title becomes the page's banner headline: Hero.astro's ladder (HeroSectionContentSchema). */
export const TITLE_MAX_WORDS = 10;
export const TITLE_MAX_WORD_LEN = 14;

export interface NewPageInput {
  titleEn: string;
  titleAr: string;
  slug: string;
}

export type NewPageErrors = Partial<Record<keyof NewPageInput, string>>;

/** Why a title cannot be the page's banner headline, or null. */
export function titleProblem(value: string, language: 'English' | 'Arabic'): string | null {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return `Give the page a title in ${language}.`;
  if (words.length > TITLE_MAX_WORDS) {
    return `Keep the title to ${TITLE_MAX_WORDS} words or fewer: it is the page’s headline.`;
  }
  if (words.some((word) => [...word].length > TITLE_MAX_WORD_LEN)) {
    return `Keep each word to ${TITLE_MAX_WORD_LEN} letters or fewer: it is the page’s headline.`;
  }
  return null;
}

/** Why the address cannot be a new page's (a route page's own included: it exists). */
export function slugProblem(value: string): string | null {
  if (isRoutePageSlug(value)) return 'The site already uses this address. Choose another one.';
  return customPageSlugProblem(value);
}

/** Every refusal, by field; empty when the dialog may send. */
export function newPageErrors(input: NewPageInput): NewPageErrors {
  const out: NewPageErrors = {};
  const en = titleProblem(input.titleEn, 'English');
  const ar = titleProblem(input.titleAr, 'Arabic');
  const slug = slugProblem(input.slug);
  if (en) out.titleEn = en;
  if (ar) out.titleAr = ar;
  if (slug) out.slug = slug;
  return out;
}

const tidy = (value: string): string => value.trim().split(/\s+/).join(' ');

/** The page's create (POST /api/admin/pages): a draft, its title and its address. */
export function newPagePayload(input: NewPageInput): Record<string, unknown> {
  return {
    slug: input.slug,
    title: { en: tidy(input.titleEn), ar: tidy(input.titleAr) },
    status: 'draft',
  };
}

/**
 * Its first section (POST /api/admin/sections): the banner hero, shown, whose headline is the
 * page's title, so the page opens with its own name from the first preview. The rest of the
 * hero (the line under it, the button's words) keeps the built-in copy until edited.
 */
export function heroPayload(pageId: string, input: NewPageInput): Record<string, unknown> {
  return {
    pageId,
    type: 'hero',
    content: { headline: { en: tidy(input.titleEn), ar: tidy(input.titleAr) } },
    visible: true,
    sortOrder: 10,
    isPlaceholder: false,
  };
}
