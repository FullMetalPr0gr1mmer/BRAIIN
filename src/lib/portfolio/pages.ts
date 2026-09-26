import type { Locale } from '@schemas/primitives';
import { PUBLIC_SITE_URL } from 'astro:env/client';
import { getPageComposition } from '@/lib/data/pageSections';
import { getPortfolioCards } from '@/lib/data/portfolio';
import { loadHead, type Head } from '@/lib/seo/head';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { buildBreadcrumbSchema, type JsonLdNode } from '@/lib/seo/jsonld';
import { localizedPath } from '@/lib/i18n';
import {
  DEFAULT_CATALOG_SECTIONS,
  DEFAULT_WORK_SECTIONS,
  type SectionData,
} from '@/lib/sections/types';
import { filterCards, isFiltered, parseFacets } from './catalog';

// The data behind Our Work (`/portfolio`) and All projects (`/portfolio/all`), one loader
// per page shared by the EN and AR routes so the two twins cannot drift.
//
// Each loader runs its reads in ONE concurrent round (cards, the page's CMS composition,
// and the head — whose SEO override needs the page id the composition query returns),
// parses the facet query against the cards the page filters, and hands each section its
// route data through SectionRenderer's `data` prop (which CMS content cannot override).
//
// `filtered` is true when the request carries ANY facet parameter, valid or not: the route
// then serves the response private (noEdgeCache) — only the bare URL is Tier-A cached, so
// a crafted query cannot fill the edge with variants. The canonical is always the bare
// page (SeoHead drops the query), in both cases.

export interface CatalogPage {
  sections: SectionData[];
  head: Head;
  jsonLd: JsonLdNode[];
  filtered: boolean;
  /**
   * `overlay` (transparent over the page's dark head) only when the page really opens on
   * one — the banner (which needs a published project) or the black page head. Otherwise
   * the solid bar: an overlay header over the white proof band would be white on white.
   */
  header: 'overlay' | 'solid';
}

/** The first section a visitor will actually see (visible: false is skipped). */
const firstVisible = (sections: SectionData[]) => sections.find((s) => s.visible !== false);

type Locals = Parameters<typeof loadHead>[0];

const HOME = { en: 'Home', ar: 'الرئيسية' } as const;

async function compose(
  slug: 'portfolio' | 'portfolio-all',
  meta: { title: string; description: string },
  locals: Locals,
  locale: Locale,
) {
  const compositionQuery = getPageComposition(slug);
  const [cards, composition, head] = await Promise.all([
    getPortfolioCards(),
    compositionQuery,
    loadHead(locals, {
      locale,
      fallbackTitle: meta.title,
      fallbackDescription: meta.description,
      entity: compositionQuery.then((c) => (c ? { type: 'page' as const, id: c.page.id } : null)),
    }),
  ]);
  return { cards, authored: composition?.sections ?? [], head };
}

function withData(
  sections: SectionData[],
  data: Partial<Record<string, Record<string, unknown>>>,
): SectionData[] {
  return sections.map((s) => {
    const injected = data[s.type];
    return injected ? { ...s, data: { ...(s.data ?? {}), ...injected } } : s;
  });
}

const absolute = (path: string, locale: Locale) =>
  PUBLIC_SITE_URL.replace(/\/$/, '') + localizedPath(path, locale);

/** Our Work: the latest-project banner, proof, intro, the featured grid, clients, lead. */
export async function loadOurWork(url: URL, locals: Locals, locale: Locale): Promise<CatalogPage> {
  const meta = PAGE_META.portfolio[locale];
  const { cards, authored, head } = await compose('portfolio', meta, locals, locale);
  const featured = cards.filter((c) => c.isFeatured);
  const selection = parseFacets(url.searchParams, featured);
  const sections = withData(authored.length ? authored : DEFAULT_WORK_SECTIONS, {
    workHero: { cards },
    projectGrid: { cards, selection },
  });
  return {
    sections,
    head,
    filtered: isFiltered(url.searchParams),
    header: firstVisible(sections)?.type === 'workHero' && cards.length > 0 ? 'overlay' : 'solid',
    jsonLd: [
      buildBreadcrumbSchema([
        { name: HOME[locale], url: absolute('/', locale) },
        { name: meta.title, url: absolute('/portfolio', locale) },
      ]),
    ],
  };
}

/** All projects: the page head (with the live count), the whole catalogue, the lead band. */
export async function loadAllProjects(
  url: URL,
  locals: Locals,
  locale: Locale,
): Promise<CatalogPage> {
  const meta = PAGE_META.portfolioAll[locale];
  const { cards, authored, head } = await compose('portfolio-all', meta, locals, locale);
  const selection = parseFacets(url.searchParams, cards);
  const sections = withData(authored.length ? authored : DEFAULT_CATALOG_SECTIONS, {
    // No count at all while nothing is published — "00 projects" above an empty page reads
    // as broken; with a catalogue it is the live number of matches.
    pageHead: cards.length > 0 ? { count: filterCards(cards, selection).length } : {},
    projectCatalog: { cards, selection },
  });
  return {
    sections,
    head,
    filtered: isFiltered(url.searchParams),
    header: firstVisible(sections)?.type === 'pageHead' ? 'overlay' : 'solid',
    jsonLd: [
      buildBreadcrumbSchema([
        { name: HOME[locale], url: absolute('/', locale) },
        { name: PAGE_META.portfolio[locale].title, url: absolute('/portfolio', locale) },
        { name: meta.title, url: absolute('/portfolio/all', locale) },
      ]),
    ],
  };
}
