import type { Locale } from '@schemas/primitives';
import type { VideoClip } from '@schemas/media';
import { EXPLORER_DISCIPLINE_TOKEN } from '@schemas/sections';
import { localizedPath, pickLocale } from '@/lib/i18n';
import type { ImageRef } from '@/lib/media/resolve';
import { FALLBACK_DISCIPLINES, serviceCount } from './cards';

// The /services explorer (Round 2, section type `serviceExplorer`) as the component renders
// it: one panel per published discipline, every panel in the HTML (the page's crawl path to
// its 28 service pages). Pure, so the links, labels, numbering and wrap-around are
// unit-tested (tests/lib/servicesPage.spec.ts).
//
// A panel's id IS the discipline's slug: `/services#events` is the contract the home cards
// (S2 `disciplineHref`), the service pages' crumb and the retired-slug 301s all link to.

/** What the explorer reads — getPublishedDisciplines()'s `Discipline` satisfies it. */
export interface ExplorerDisciplineInput {
  slug: string;
  name: { en: string; ar?: string | undefined };
  blurb: { en: string; ar?: string | undefined } | null;
  poster: ImageRef | null;
  clip: VideoClip | null;
  services: readonly {
    slug: string;
    title: { en: string; ar?: string | undefined };
    poster: ImageRef | null;
    clip: VideoClip | null;
  }[];
}

/** The design's copy (services.html `x.*`), and the labels the design never showed. */
export const EXPLORER_COPY: Record<
  Locale,
  {
    inquire: string;
    start: string;
    /** The tablist's name — the pills are the only thing that names the set. */
    tabs: string;
    /** The explorer region's name (it has no visible heading of its own). */
    region: string;
    /** Screen-reader prefixes for the prev/next links, whose visible text is just a name. */
    prev: string;
    next: string;
  }
> = {
  en: {
    inquire: 'Inquire',
    start: `Start your ${EXPLORER_DISCIPLINE_TOKEN} project`,
    tabs: 'Disciplines',
    region: 'Services by discipline',
    prev: 'Previous discipline: ',
    next: 'Next discipline: ',
  },
  ar: {
    inquire: 'اطلب',
    start: `ابدأ مشروع ${EXPLORER_DISCIPLINE_TOKEN}`,
    tabs: 'التخصصات',
    region: 'الخدمات حسب التخصص',
    prev: 'التخصص السابق: ',
    next: 'التخصص التالي: ',
  },
};

export interface ExplorerService {
  /** "01"… its place in the discipline. */
  n: string;
  slug: string;
  name: string;
  href: string;
  inquireHref: string;
  /** "Inquire: Logo Design" — the pill's accessible name (its visible text is the start of it). */
  inquireLabel: string;
  /** What the panel media swaps to while the row is hovered or focused: the service's own
      poster and window, else the discipline's (the media never goes blank). */
  poster: ImageRef | null;
  clip: VideoClip | null;
}

export interface ExplorerPanel {
  slug: string;
  n: string;
  name: string;
  blurb: string;
  /** "01 / 05" */
  position: string;
  /** "8 services" / "8 خدمات" (the cards' plural rule); null for the code fallback. */
  count: string | null;
  tabId: string;
  headingId: string;
  services: ExplorerService[];
  prev: { slug: string; name: string };
  next: { slug: string; name: string };
  startLabel: string;
  poster: ImageRef | null;
  clip: VideoClip | null;
}

const pad2 = (i: number) => String(i + 1).padStart(2, '0');

/** The neighbour `step` panels away, wrapping at both ends (the design's prev/next). */
export function wrapIndex(i: number, step: number, count: number): number {
  if (count <= 0) return 0;
  return (((i + step) % count) + count) % count;
}

/** A label override or the design's, with the discipline's name in place of the token. */
export function startLabelFor(name: string, locale: Locale, override?: string): string {
  return (override || EXPLORER_COPY[locale].start).split(EXPLORER_DISCIPLINE_TOKEN).join(name);
}

export function toExplorerPanels(
  disciplines: readonly ExplorerDisciplineInput[],
  locale: Locale,
  labels: { inquire?: string | undefined; start?: string | undefined } = {},
): ExplorerPanel[] {
  const inquire = labels.inquire || EXPLORER_COPY[locale].inquire;
  const names = disciplines.map((d) => pickLocale(d.name, locale, d.slug));
  const total = String(disciplines.length).padStart(2, '0');
  return disciplines.map((d, i) => {
    const name = names[i] ?? d.slug;
    const neighbour = (step: number) => {
      const j = wrapIndex(i, step, disciplines.length);
      return { slug: disciplines[j]?.slug ?? d.slug, name: names[j] ?? name };
    };
    return {
      slug: d.slug,
      n: pad2(i),
      name,
      blurb: pickLocale(d.blurb, locale),
      position: `${pad2(i)} / ${total}`,
      count: serviceCount(d.services.length, locale),
      tabId: `svc-tab-${d.slug}`,
      headingId: `svc-panel-${d.slug}-h`,
      services: d.services.map((s, k) => {
        const serviceName = pickLocale(s.title, locale, s.slug);
        const href = localizedPath(`/services/${s.slug}`, locale);
        return {
          n: pad2(k),
          slug: s.slug,
          name: serviceName,
          href,
          inquireHref: `${href}#inquiry`,
          inquireLabel: `${inquire}: ${serviceName}`,
          poster: s.poster ?? d.poster,
          clip: s.clip?.path ? s.clip : d.clip,
        };
      }),
      prev: neighbour(-1),
      next: neighbour(1),
      startLabel: startLabelFor(name, locale, labels.start),
      poster: d.poster,
      clip: d.clip,
    };
  });
}

/**
 * The five disciplines as text-only panels — rendered ONLY when the database cannot be
 * read (an outage, or a build before Supabase), so the fallback cards' `#<slug>` links
 * still open something. The same names as the cards' fallback (cards.ts), the card line
 * standing in for the blurb; no services, no count, no media.
 */
export function fallbackExplorerPanels(
  locale: Locale,
  labels: { start?: string | undefined } = {},
): ExplorerPanel[] {
  const panels = toExplorerPanels(
    FALLBACK_DISCIPLINES.map((d) => ({
      slug: d.slug,
      name: d.name,
      blurb: d.short,
      poster: null,
      clip: null,
      services: [],
    })),
    locale,
    labels,
  );
  return panels.map((p) => ({ ...p, count: null }));
}
