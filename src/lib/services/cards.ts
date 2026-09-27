import type { Locale } from '@schemas/primitives';
import type { Accent, VideoClip } from '@schemas/media';
import { localizedPath, pickLocale } from '@/lib/i18n';
import { countLabel, type PluralForms } from '@/lib/i18n/plural';
import type { ImageRef } from '@/lib/media/resolve';

// The discipline cards (Round 2, `servicesOverview`) as the component renders them: pure,
// so the links, counts and fallback are unit-tested (tests/lib/serviceCards.spec.ts).
//
//   home  white band; a card links to /services#<slug> (locale-aware); the "All services"
//         button closes the band; section id `services` (the /#services deep link stays)
//   page  the /services mist band (S3); a card links to #<slug> — the explorer panel on the
//         same page; no button; section id `categories`

export type DisciplineCardsMode = 'home' | 'page';

/** The shape the cards read — getPublishedDisciplines()'s `Discipline` satisfies it. */
export interface DisciplineCardInput {
  slug: string;
  name: { en: string; ar?: string | undefined };
  short: { en: string; ar?: string | undefined } | null;
  poster: ImageRef | null;
  clip: VideoClip | null;
  services: readonly unknown[];
}

export interface DisciplineCard {
  slug: string;
  /** "01"… — the card's position, Western digits in both languages (the mockup's pill). */
  n: string;
  href: string;
  name: string;
  short: string;
  /** "8 services" / "8 خدمات"; null for the code fallback, which cannot know the count. */
  count: string | null;
  poster: ImageRef | null;
  clip: VideoClip | null;
}

/**
 * "8 services" / "8 خدمات". The noun follows the Arabic plural categories (Intl.PluralRules
 * via countLabel): 1 خدمة, 2 خدمتان, 3–10 خدمات, 11–99 خدمةً, 100+ خدمة. The digits are
 * Western in both languages, as the mockup's cards have them — the site's digit rule
 * (docs/design-port-2026-09.md decision 5: counts stay Western; Arabic-Indic digits only
 * where the design's Arabic sentences use them).
 */
export const SERVICE_COUNT_FORMS: Record<Locale, PluralForms> = {
  en: { one: '{n} service', other: '{n} services' },
  ar: {
    zero: '{n} خدمة',
    one: '{n} خدمة',
    two: '{n} خدمتان',
    few: '{n} خدمات',
    many: '{n} خدمةً',
    other: '{n} خدمة',
  },
};

export function serviceCount(n: number, locale: Locale): string {
  return countLabel(n, SERVICE_COUNT_FORMS[locale], locale, { pad: 0 });
}

/** Where a card points: the /services explorer panel, from home or on the page itself. */
export function disciplineHref(slug: string, mode: DisciplineCardsMode, locale: Locale): string {
  return mode === 'page' ? `#${slug}` : `${localizedPath('/services', locale)}#${slug}`;
}

/** The section's anchor: `services` on home (the /#services deep link), `categories` on /services. */
export function disciplineSectionId(mode: DisciplineCardsMode): 'services' | 'categories' {
  return mode === 'page' ? 'categories' : 'services';
}

const pad2 = (i: number) => String(i + 1).padStart(2, '0');

export function toDisciplineCards(
  disciplines: readonly DisciplineCardInput[],
  mode: DisciplineCardsMode,
  locale: Locale,
): DisciplineCard[] {
  return disciplines.map((d, i) => ({
    slug: d.slug,
    n: pad2(i),
    href: disciplineHref(d.slug, mode, locale),
    name: pickLocale(d.name, locale, d.slug),
    short: pickLocale(d.short, locale),
    count: serviceCount(d.services.length, locale),
    poster: d.poster,
    clip: d.clip,
  }));
}

/**
 * The five disciplines as text only — rendered ONLY when the database cannot be read (an
 * outage, or a build before Supabase is provisioned), so the band never renders empty.
 * Names and lines are the design's (supabase/seed-data/08-disciplines.json carries the same
 * words; tests/lib/serviceCards.spec.ts holds the two together). No counts and no media:
 * the fallback cannot know either.
 */
export const FALLBACK_DISCIPLINES: readonly {
  slug: string;
  name: { en: string; ar: string };
  short: { en: string; ar: string };
}[] = [
  {
    slug: 'branding',
    name: { en: 'Branding', ar: 'الهوية البصرية' },
    short: {
      en: 'The mark, the system, and everything it touches.',
      ar: 'الشعار والنظام، وكل شي يلمسه.',
    },
  },
  {
    slug: 'production',
    name: { en: 'Production', ar: 'الإنتاج' },
    short: {
      en: 'Film, motion, photo and sound, made in house.',
      ar: 'فيديو وموشن وتصوير وصوت، كله ننتجه داخل الفريق.',
    },
  },
  {
    slug: 'marketing',
    name: { en: 'Marketing', ar: 'التسويق' },
    short: {
      en: 'Strategy, content, and ads that move people to act.',
      ar: 'استراتيجية ومحتوى وإعلانات تحرّك الناس للفعل.',
    },
  },
  {
    slug: 'web',
    name: { en: 'Website Development', ar: 'تطوير المواقع' },
    short: {
      en: 'Fast, secure sites that people and AI find.',
      ar: 'مواقع سريعة وآمنة يلقاها الناس والذكاء الاصطناعي.',
    },
  },
  {
    slug: 'events',
    name: { en: 'Events & Exhibitions', ar: 'الفعاليات والمعارض' },
    short: {
      en: 'Booths and event spaces, from 3D to show day.',
      ar: 'أجنحة ومساحات فعاليات، من تصميم 3D إلى يوم الافتتاح.',
    },
  },
];

export function fallbackDisciplineCards(
  mode: DisciplineCardsMode,
  locale: Locale,
): DisciplineCard[] {
  return FALLBACK_DISCIPLINES.map((d, i) => ({
    slug: d.slug,
    n: pad2(i),
    href: disciplineHref(d.slug, mode, locale),
    name: d.name[locale],
    short: d.short[locale],
    count: null,
    poster: null,
    clip: null,
  }));
}

/**
 * The band's built-in copy, verbatim from the mockups: home is index.html's `services.*`
 * keys, page mode services.html's `s.catTag` / `s.catH` / `s.catP` / `s.hint`. The accent
 * is a word range of the built-in heading ("Five disciplines, <em>one studio</em>").
 */
export const DISCIPLINE_BAND_COPY: Record<
  DisciplineCardsMode,
  Record<
    Locale,
    { tag: string; heading: string; sub: string; hint: string; allLabel: string | null }
  > & { accent: Accent }
> = {
  home: {
    en: {
      tag: 'What we do',
      heading: 'Five disciplines, one studio',
      sub: 'Take one. Take all of them. The work holds together either way, because it never leaves the building.',
      hint: 'Open one to see every service inside it',
      allLabel: 'All services',
    },
    ar: {
      tag: 'ما نقدّمه',
      heading: 'خمسة تخصصات، استوديو واحد',
      sub: 'خذ واحدة، أو خذها كلها. الشغل يبقى متماسكاً في الحالتين، لأنه لا يغادر المبنى.',
      hint: 'افتح أي تخصص وشوف كل خدماته',
      allLabel: 'كل الخدمات',
    },
    accent: { en: { from: 2 }, ar: { from: 2 } },
  },
  page: {
    en: {
      tag: 'Our services',
      heading: 'Everything your brand needs',
      sub: 'Five disciplines, twenty eight services. Open one to see everything inside it.',
      hint: 'Tap a discipline to open it',
      allLabel: null,
    },
    ar: {
      tag: 'خدماتنا',
      heading: 'كل اللي تحتاجه علامتك',
      sub: 'خمسة تخصصات وثمان وعشرون خدمة. افتح أي تخصص وشوف كل اللي فيه.',
      hint: 'اضغط على أي تخصص لفتحه',
      allLabel: null,
    },
    accent: { en: { from: 3 }, ar: { from: 3 } },
  },
};
