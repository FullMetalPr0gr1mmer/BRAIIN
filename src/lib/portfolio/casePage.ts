import type { Locale } from '@schemas/primitives';
import {
  getCaseStudy,
  getPortfolioCards,
  type CaseStudy,
  type PortfolioCard,
} from '@/lib/data/portfolio';
import { getTestimonials, type Testimonial } from '@/lib/data/taxonomy';
import { loadHead, type Head } from '@/lib/seo/head';
import { CASE_STUDY_META } from '@/lib/seo/pageMeta';
import { pickLocale, pickLocaleStrict } from '@/lib/i18n';
import { nextProject } from './caseStudy';

// The data behind one case study (/portfolio/[slug] and /ar/portfolio/[slug], UI v2 PR11),
// one loader shared by both twins so they cannot drift.
//
// Everything starts in ONE round: the case study, the published cards (for "Next
// project"), the head (identity + SEO defaults) — and, chained only on the case-study
// query, the project's quote and its `entity_seo` override. Nothing waits on anything it
// does not need, so the page costs the case-study query plus one dependent read.
//
// null = no such PUBLISHED case study (or a row the schema rejects): the route answers a
// real 404 — the mockup silently rendered The Rider for any unknown slug.

export interface CaseStudyPage {
  study: CaseStudy;
  next: PortfolioCard | null;
  /** The project's own published testimonial; null hides the quote band. */
  quote: Testimonial | null;
  head: Head;
}

type Locals = Parameters<typeof loadHead>[0];

/** The page title: "The Rider | Brand film" (the mockup's own), or the name alone. */
export function caseTitle(study: Pick<CaseStudy, 'title' | 'projectType'>, locale: Locale) {
  const name = pickLocale(study.title, locale);
  const type = study.projectType ? pickLocale(study.projectType, locale) : '';
  return type ? `${name} | ${type}` : name;
}

/**
 * The meta description: the project's teaser, else its summary — strictly in the page's
 * language (no English on an Arabic page) — else the generic case-study line.
 */
export function caseDescription(
  study: Pick<CaseStudy, 'blurb' | 'summary'>,
  locale: Locale,
): string {
  return (
    pickLocaleStrict(study.blurb, locale) ||
    pickLocaleStrict(study.summary, locale) ||
    CASE_STUDY_META[locale].description
  );
}

/**
 * The CreativeWork `description`: the meta description's text with the brand filled in.
 * caseDescription feeds loadHead, whose resolveSeo substitutes `%brand%`; the JSON-LD
 * builder does no substitution, so the generic fallback would ship the raw token.
 */
export function caseSchemaDescription(
  study: Pick<CaseStudy, 'blurb' | 'summary'>,
  locale: Locale,
  brand: string,
): string {
  return caseDescription(study, locale).replace(/%brand%/g, () => brand);
}

export async function loadCaseStudyPage(
  slug: string,
  locals: Locals,
  locale: Locale,
): Promise<CaseStudyPage | null> {
  const studyQuery = getCaseStudy(slug);
  const [study, cards, quotes, head] = await Promise.all([
    studyQuery,
    getPortfolioCards(),
    studyQuery.then((s) => (s ? getTestimonials({ portfolioId: s.id, limit: 1 }) : [])),
    loadHead(locals, {
      locale,
      fallbackTitle: studyQuery.then((s) => (s ? caseTitle(s, locale) : '')),
      fallbackDescription: studyQuery.then((s) => (s ? caseDescription(s, locale) : '')),
      entity: studyQuery.then((s) => (s ? { type: 'portfolio' as const, id: s.id } : null)),
    }),
  ]);
  if (!study) return null;
  return {
    study,
    next: nextProject(cards, study),
    quote: quotes[0] ?? null,
    head,
  };
}
