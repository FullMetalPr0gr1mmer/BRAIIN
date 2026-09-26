import type { Locale } from '@schemas/primitives';
import { countLabel, type PluralForms } from '@/lib/i18n/plural';
import type { Facet } from './catalog';

// The filter bar's own words (Our Work + All projects) — built-in chrome, not CMS content,
// verbatim from the mockup's catalogue I18N in both languages. ONE copy, imported by the
// server components AND the browser enhancement (src/lib/client/catalogFilter.ts), so a
// count or a label the script rewrites always reads exactly what the server rendered.
//
// Digits are Latin in both languages and zero-padded where the mockup pads them ("06 of
// 06 featured", "12 projects"); the see-all count is not padded (the mockup's own format).

export interface FilterStrings {
  facet: Record<Facet, string>;
  all: Record<Facet, string>;
  filterBy: string;
  clear: string;
  remove: string;
  none: string;
  seeAll: string;
  /** `{n}` = the number of matching projects across the whole catalogue. */
  seeMatching: string;
  /** No-JS only: submits the selects (the enhancement applies them on change). */
  apply: string;
  /** Accessible name of the result list (the grid). */
  results: string;
}

export const FILTER_STR: Record<Locale, FilterStrings> = {
  en: {
    facet: { service: 'Service', sector: 'Sector', client: 'Client', year: 'Year' },
    all: {
      service: 'All services',
      sector: 'All sectors',
      client: 'All clients',
      year: 'All years',
    },
    filterBy: 'Filter by',
    clear: 'Clear filters',
    remove: 'Remove filter',
    none: 'No projects match these filters.',
    seeAll: 'See all projects',
    seeMatching: 'See all {n} matching projects',
    apply: 'Apply filters',
    results: 'Projects',
  },
  ar: {
    facet: { service: 'الخدمة', sector: 'القطاع', client: 'العميل', year: 'السنة' },
    all: {
      service: 'كل الخدمات',
      sector: 'كل القطاعات',
      client: 'كل العملاء',
      year: 'كل السنوات',
    },
    filterBy: 'فلترة حسب',
    clear: 'امسح الفلاتر',
    remove: 'إزالة الفلتر',
    none: 'ما في مشاريع تطابق هذه الفلاتر.',
    seeAll: 'شوف كل المشاريع',
    seeMatching: 'شوف كل المشاريع المطابقة ({n})',
    // Ours (the mockup has no no-JS path) — owner review.
    apply: 'طبّق الفلاتر',
    results: 'المشاريع',
  },
};

/**
 * "12 projects" / "12 مشروعًا". The mockup writes "مشاريع" for every Arabic count; the
 * noun follows the Arabic plural categories here (Intl.PluralRules via countLabel):
 * 1 مشروع, 2 مشروعان, 3–10 مشاريع, 11–99 مشروعًا, 100+ مشروع.
 */
export const PROJECT_COUNT_FORMS: Record<Locale, PluralForms> = {
  en: { one: '{n} project', other: '{n} projects' },
  ar: {
    zero: '{n} مشروع',
    one: '{n} مشروع',
    two: '{n} مشروعان',
    few: '{n} مشاريع',
    many: '{n} مشروعًا',
    other: '{n} مشروع',
  },
};

export function projectCount(n: number, locale: Locale): string {
  return countLabel(n, PROJECT_COUNT_FORMS[locale], locale);
}

const pad = (n: number) => String(Math.max(0, Math.trunc(n))).padStart(2, '0');

/** Our Work's head count: "06 of 06 featured" / "06 من 06 مختارة" (the mockup verbatim). */
export function featuredCount(shown: number, total: number, locale: Locale): string {
  return locale === 'ar'
    ? `${pad(shown)} من ${pad(total)} مختارة`
    : `${pad(shown)} of ${pad(total)} featured`;
}

/** The see-all button: the plain label, or the matching count when a filter is on. */
export function seeAllLabel(matching: number | null, locale: Locale): string {
  const s = FILTER_STR[locale];
  return matching === null ? s.seeAll : s.seeMatching.replace('{n}', String(matching));
}

/**
 * A pill's accessible name: "Sector: Automotive, remove filter" / "القطاع: السيارات، إزالة
 * الفلتر". It STARTS with the pill's visible text (the facet label, then the value — the ×
 * is aria-hidden), so a speech-input user who says what they see gets a match (WCAG 2.5.3
 * Label in Name); the action follows.
 */
export function removeLabel(facet: Facet, value: string, locale: Locale): string {
  const s = FILTER_STR[locale];
  return locale === 'ar'
    ? `${s.facet[facet]}: ${value}، ${s.remove}`
    : `${s.facet[facet]}: ${value}, ${s.remove.toLowerCase()}`;
}
