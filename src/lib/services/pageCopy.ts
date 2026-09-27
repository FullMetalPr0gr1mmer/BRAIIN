import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';

// The service page's own copy (Round 2 — service.html, `i18n_service` `v.*`), verbatim in
// both languages. The words that change per page (the service, its discipline) come from
// the database; these are the labels around them. Pure, so the copy and the accent word
// ranges are unit-tested.
//
// `crumb`/`home` are the site's own nav words (the mockup's `nav.services` / `nav.home`);
// `confidential` is FacetTags' wording, so a hidden client reads the same everywhere.

export interface ServicePageCopy {
  home: string;
  services: string;
  /** v.skipK / v.skip — the hero's glass pill ("Been here before? Skip to the inquiry"). */
  skipKicker: string;
  skip: string;
  /** v.how — the hero CTA when the page has a case block. */
  seeCase: string;
  whatTag: string;
  get: string;
  valueTag: string;
  /** v.valH "Why it's <em>worth it</em>" as text + the accented word range. */
  valueHeading: string;
  valueLead: string;
  caseTag: string;
  seeProject: string;
  context: string;
  problem: string;
  did: string;
  /** v.moreTag "More in {c}". */
  moreTag: string;
  all: string;
  fab: string;
  confidential: string;
}

export const SERVICE_PAGE_COPY: Record<Locale, ServicePageCopy> = {
  en: {
    home: 'Home',
    services: 'Services',
    skipKicker: 'Been here before?',
    skip: 'Skip to the inquiry',
    seeCase: 'See the case study',
    whatTag: 'The service',
    get: 'What you get',
    valueTag: 'The value we add',
    valueHeading: "Why it's worth it",
    valueLead: 'What working with us adds, beyond a template or a one off freelancer.',
    caseTag: 'Case study',
    seeProject: 'See the full project',
    context: 'Where they were',
    problem: 'The problem',
    did: 'What we did',
    moreTag: 'More in {c}',
    all: 'All services',
    fab: 'Skip to inquiry',
    confidential: 'Confidential client',
  },
  ar: {
    home: 'الرئيسية',
    services: 'الخدمات',
    skipKicker: 'زرتنا قبل؟',
    skip: 'انتقل للطلب مباشرة',
    seeCase: 'شوف دراسة الحالة',
    whatTag: 'الخدمة',
    get: 'وش تستلم',
    valueTag: 'القيمة اللي نضيفها',
    valueHeading: 'ليش تستاهل',
    valueLead: 'وش يضيف لك الشغل معنا، أبعد من قالب جاهز أو تعاون لمرة وحدة.',
    caseTag: 'دراسة حالة',
    seeProject: 'شوف المشروع كامل',
    context: 'وين كانوا',
    problem: 'المشكلة',
    did: 'وش سوّينا',
    moreTag: 'المزيد في {c}',
    all: 'كل الخدمات',
    fab: 'انتقل للطلب',
    confidential: 'عميل غير مُعلَن',
  },
};

// "Why it's <em>worth it</em>" / "ليش <em>تستاهل</em>".
export const VALUE_ACCENT: Accent = { en: { from: 2 }, ar: { from: 1 } };

// v.moreH: "Everything in <em>{c}</em>" / "كل خدمات <em>{c}</em>" — the lead-in, then the
// discipline's name as the accent.
const MORE_LEAD: Record<Locale, string> = { en: 'Everything in', ar: 'كل خدمات' };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** A heading whose accent is everything after a fixed lead-in: "Everything in *Branding*". */
export interface TailHeading {
  text: string;
  accent: Accent;
}

function tailHeading(lead: string, tail: string, locale: Locale): TailHeading {
  const range = { from: words(lead) };
  return {
    text: `${lead} ${tail.trim()}`,
    accent: locale === 'ar' ? { ar: range } : { en: range },
  };
}

/** "Everything in *Branding*" — the "More in {Discipline}" heading. */
export function moreHeading(discipline: string, locale: Locale): TailHeading {
  return tailHeading(MORE_LEAD[locale], discipline, locale);
}

/** "More in Branding" — the section's kicker. A function replacement: never `$&` expansion. */
export function moreTag(discipline: string, locale: Locale): string {
  return SERVICE_PAGE_COPY[locale].moreTag.replace('{c}', () => discipline.trim());
}
