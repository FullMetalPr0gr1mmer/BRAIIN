import { customPageSlugProblem } from '@schemas/customPages';

// The New page dialog's rules (Admin v2 E11), pure: the island and tests/lib/customPages.spec.ts
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

/** Every refusal, by field; empty when the dialog may send. */
export function newPageErrors(input: NewPageInput): NewPageErrors {
  const out: NewPageErrors = {};
  const en = titleProblem(input.titleEn, 'English');
  const ar = titleProblem(input.titleAr, 'Arabic');
  // The address's one rule (E11 code review, CR9): a route slug is refused there too.
  const slug = customPageSlugProblem(input.slug);
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

/**
 * How the dialog adds the banner: its POST (the island's own adminFetch of
 * `stagedUrl('/api/admin/sections', releaseMode)` with heroPayload, where the release-mode
 * scan reads it, tests/lib/releaseModeWrites.spec.ts), and the client error channel.
 */
export interface BannerIo {
  post: () => Promise<unknown>;
  report: (message: string) => void;
}

export type BannerOutcome = { added: true } | { added: false; error: unknown };

/**
 * Adds the new page's banner hero. A refusal is never swallowed (E11 code review, CR4): it is
 * reported through the client error channel, naming the page's id and the error, never the
 * title, and handed back for the dialog to say, with Try again and Open the page.
 */
export async function addBanner(pageId: string, io: BannerIo): Promise<BannerOutcome> {
  try {
    await io.post();
    return { added: true };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    io.report(`New page ${pageId}: the page was made, its banner was not (${why}).`);
    return { added: false, error };
  }
}

/** What the dialog says when the page was made and its banner was not. */
export function bannerMissing(why: string): string {
  return `The page was made as a draft, but its banner was not added (${why}). Try again, or open the page and add a Hero from Add section.`;
}
