import type { Locale } from '@schemas/primitives';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPageComposition } from '@/lib/data/pageSections';
import { getPublishedDisciplines, type Discipline } from '@/lib/data/disciplines';
import { loadHead, type Head } from '@/lib/seo/head';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { buildBreadcrumbSchema, type JsonLdNode } from '@/lib/seo/jsonld';
import { localizedPath } from '@/lib/i18n';
import { DEFAULT_SERVICES_SECTIONS, withHeroPreset, type SectionData } from '@/lib/sections/types';

// The Services page (`/services`, `/ar/services`, Round 2): one loader shared by the EN and
// AR routes so the twins cannot drift. One concurrent round — the CMS composition, the head
// (whose per-page SEO override needs the page id the composition query returns) and the
// published disciplines, loaded ONCE and handed to every band that shows them: the cards,
// the explorer and the "Say hello" form's grouped select (each would otherwise run its own
// two queries).
//
// Route-level guarantees on top of whatever the CMS composed:
//   withHeroPreset('services')  the banner hero with the services copy and loop window;
//   ensureServiceExplorer       the page-mode cards are `#<slug>` links INTO the explorer,
//                               so while the cards show, the explorer does too;
//   withServicesData            with NO visible cards the explorer is `standalone`: nothing
//                               else on the page opens it, so it opens its first panel;
//   servicesPageLinks           the hero CTA, its alt link and the explorer's "Start your…"
//                               point at bands that are actually on the page.

/** What a publish of any of it must purge (Tier A, both locales). */
export const SERVICES_CACHE_ENTITIES = [
  'page:services',
  'services:all',
  'disciplines:all',
  'statistics:all',
  'media:all',
] as const;

const shown = (sections: readonly SectionData[], type: string) =>
  sections.some((s) => s.type === type && s.visible !== false);

/**
 * Where the page's links go, given what it will actually render: the hero CTA to the cards
 * (else to the standalone explorer's first panel, `explorerSlug`, else the form), the alt
 * link and every "Start your {Discipline} project" to this page's "Say hello" (else the
 * contact page's form — an anchor to a band that is not there is a dead button, the home
 * CTA's rule).
 */
export function servicesPageLinks(
  sections: readonly SectionData[],
  explorerSlug?: string,
): {
  ctaHref: string;
  inquiryHref: string;
} {
  const inquiryHref = shown(sections, 'hello') ? '#inquiry' : '/contact#inquiry';
  const explorer = explorerSlug && shown(sections, 'serviceExplorer') ? `#${explorerSlug}` : null;
  return {
    ctaHref: shown(sections, 'servicesOverview') ? '#categories' : (explorer ?? inquiryHref),
    inquiryHref,
  };
}

/**
 * The explorer is the page-mode cards' target: each card is a `#<slug>` link into it, and
 * it carries the page's 28 service links. So while a visible card band is on the page, the
 * explorer is too — shown if hidden, or put back right after the cards if removed. A floor,
 * like the contact page's inquiry form; with the cards hidden it is the editor's call.
 */
export function ensureServiceExplorer(sections: readonly SectionData[]): SectionData[] {
  if (!shown(sections, 'servicesOverview')) return [...sections];
  if (sections.some((s) => s.type === 'serviceExplorer')) {
    return sections.map((s) => (s.type === 'serviceExplorer' ? { ...s, visible: true } : s));
  }
  const at = sections.findIndex((s) => s.type === 'servicesOverview' && s.visible !== false) + 1;
  return [...sections.slice(0, at), { type: 'serviceExplorer' }, ...sections.slice(at)];
}

/**
 * The route's own data, as SectionRenderer `data` (never CMS content): the disciplines to
 * the cards (in page mode), the explorer and the form; the link targets to the hero and the
 * explorer. Only the FIRST hero is the banner (withHeroPreset) and gets the targets.
 *
 * `standalone`: with no visible card band, nothing on the page can open the explorer (its
 * tabs are inside it, and a collapsed explorer shows nothing), so a bare /services visit
 * would never see a panel or the 28 service links. A standalone explorer shows its first
 * panel from first paint instead (CSS; the script starts from the same panel), and the
 * hero CTA points at it.
 */
export function withServicesData<D extends { slug: string }>(
  sections: readonly SectionData[],
  data: { disciplines: readonly D[] },
): SectionData[] {
  const standalone = !shown(sections, 'servicesOverview');
  const links = servicesPageLinks(sections, standalone ? data.disciplines[0]?.slug : undefined);
  let heroSeen = false;
  return sections.map((s) => {
    switch (s.type) {
      case 'servicesOverview':
        return { ...s, data: { ...s.data, mode: 'page', disciplines: data.disciplines } };
      case 'serviceExplorer':
        return {
          ...s,
          data: {
            ...s.data,
            disciplines: data.disciplines,
            inquiryHref: links.inquiryHref,
            standalone,
          },
        };
      case 'hello':
        return { ...s, data: { ...s.data, groups: data.disciplines } };
      case 'hero': {
        if (heroSeen) return s;
        heroSeen = true;
        const alt = s.data?.['altLink'] as { label: unknown; href: string } | undefined;
        return {
          ...s,
          data: {
            ...s.data,
            ctaHref: links.ctaHref,
            ...(alt ? { altLink: { ...alt, href: links.inquiryHref } } : {}),
          },
        };
      }
      default:
        return s;
    }
  });
}

/** The first section a visitor will actually see. */
const firstVisible = (sections: readonly SectionData[]) =>
  sections.find((s) => s.visible !== false);

export interface ServicesPage {
  sections: SectionData[];
  head: Head;
  jsonLd: JsonLdNode[];
  /**
   * `overlay` only when the page opens on its dark banner hero; an editor who hides the
   * hero would otherwise put a white-on-white header over the white proof band.
   */
  header: 'overlay' | 'solid';
  /** No visible hero means no visible h1: the page then carries a visually hidden one. */
  hiddenH1: boolean;
}

/** The composed page's sections with the route's guarantees and data applied (pure). */
export function composeServicesPage(
  authored: readonly SectionData[],
  disciplines: readonly Discipline[],
): SectionData[] {
  const composition = authored.length > 0 ? authored : DEFAULT_SERVICES_SECTIONS;
  return withServicesData(ensureServiceExplorer(withHeroPreset(composition, 'services')), {
    disciplines,
  });
}

type Locals = Parameters<typeof loadHead>[0];

const HOME = { en: 'Home', ar: 'الرئيسية' } as const;

export async function loadServicesPage(locals: Locals, locale: Locale): Promise<ServicesPage> {
  const meta = PAGE_META.services[locale];
  const compositionQuery = getPageComposition('services');
  const [composition, head, disciplines] = await Promise.all([
    compositionQuery,
    loadHead(locals, {
      locale,
      fallbackTitle: meta.title,
      fallbackDescription: meta.description,
      entity: compositionQuery.then((c) => (c ? { type: 'page' as const, id: c.page.id } : null)),
    }),
    getPublishedDisciplines(),
  ]);
  const sections = composeServicesPage(composition?.sections ?? [], disciplines);
  const opensOnHero = firstVisible(sections)?.type === 'hero';
  const base = PUBLIC_SITE_URL.replace(/\/$/, '');
  return {
    sections,
    head,
    header: opensOnHero ? 'overlay' : 'solid',
    hiddenH1: !shown(sections, 'hero'),
    jsonLd: [
      buildBreadcrumbSchema([
        { name: HOME[locale], url: base + localizedPath('/', locale) },
        { name: meta.title, url: base + localizedPath('/services', locale) },
      ]),
    ],
  };
}
