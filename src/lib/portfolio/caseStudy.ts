import type { Locale } from '@schemas/primitives';
import type { LocalizedText } from '@schemas/content';
import { countLabel, type PluralForms } from '@/lib/i18n/plural';
import type { CaseMedia, CaseStudy, PortfolioCard } from '@/lib/data/portfolio';

// Pure decisions behind the case-study page (/portfolio/[slug], UI v2 PR11) — kept out of
// the components so they are unit-tested (tests/lib/caseStudy.spec.ts) and shared by the
// EN and AR twins.

/**
 * The "Next project" band: the editor's pick (`next_portfolio_id`) when it points at
 * another PUBLISHED project, else the next one in catalogue order (sort_order — the
 * order `cards` arrive in), wrapping from the last back to the first, as the mockup does.
 * null when there is nothing else to go to.
 */
export function nextProject(
  cards: readonly PortfolioCard[],
  current: { id: string; nextPortfolioId: string | null },
): PortfolioCard | null {
  const others = cards.filter((c) => c.id !== current.id);
  if (others.length === 0) return null;
  if (current.nextPortfolioId) {
    const pick = others.find((c) => c.id === current.nextPortfolioId);
    if (pick) return pick;
  }
  const at = cards.findIndex((c) => c.id === current.id);
  // Not in the list (a race with an unpublish): the catalogue's first project.
  if (at === -1) return others[0] ?? null;
  return cards[(at + 1) % cards.length] ?? null;
}

/** The keyword chips: the authored keywords, else the project type alone (the mockup's fallback). */
export function caseKeywords(study: Pick<CaseStudy, 'keywords' | 'projectType'>): LocalizedText[] {
  if (study.keywords.length > 0) return study.keywords;
  return study.projectType ? [study.projectType] : [];
}

/**
 * A breakdown or gallery image may only be shown when it can be DESCRIBED in both
 * languages — the case study is the one place stills are content, not decoration (alt is
 * required, PR11). A caption describes it (it is bilingual by schema); otherwise the
 * asset's own alt must exist in EN and AR. An image that fails is left out rather than
 * rendered with alt="" (the dashboard's missing-alt banner, 0025, tells the editor).
 */
export function describable(media: CaseMedia): boolean {
  if (!media.image) return false;
  if (media.caption) return true;
  return media.image.alt.en !== '' && media.image.alt.ar !== '';
}

/** The alt text of a still in this locale: its own description first, the caption second. */
export function stillAlt(media: CaseMedia, locale: Locale): string {
  const own = media.image?.alt[locale] ?? '';
  if (own) return own;
  return media.caption ? media.caption[locale] : '';
}

/**
 * "09 stills" / "09 لقطات". The mockup writes "لقطة" for every Arabic count; the noun
 * follows the Arabic plural categories here, as the project counts do (decision 22).
 */
export const STILLS_COUNT_FORMS: Record<Locale, PluralForms> = {
  en: { one: '{n} still', other: '{n} stills' },
  ar: {
    zero: '{n} لقطة',
    one: '{n} لقطة',
    two: '{n} لقطتان',
    few: '{n} لقطات',
    many: '{n} لقطةً',
    other: '{n} لقطة',
  },
};

export function stillsCount(n: number, locale: Locale): string {
  return countLabel(n, STILLS_COUNT_FORMS[locale], locale);
}

/** "01" … the mockup's two-digit scope numbers and lightbox counter. */
export const pad2 = (n: number): string => String(Math.max(0, Math.trunc(n))).padStart(2, '0');
