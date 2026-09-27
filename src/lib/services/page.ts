import type { Locale } from '@schemas/primitives';
import { getServiceBySlug, toServiceDetail, type ServiceDetail } from '@/lib/data/services';
import { getPublishedDisciplines, type Discipline } from '@/lib/data/disciplines';
import { getServiceCase, type ServiceCase } from '@/lib/data/serviceCases';
import { loadHead, type Head } from '@/lib/seo/head';
import { SERVICE_PAGE_META } from '@/lib/seo/pageMeta';
import { pickLocale, pickLocaleStrict } from '@/lib/i18n';
import { retiredRedirect } from './retired';

// The data behind one service page (/services/[slug] and /ar/services/[slug], Round 2),
// one loader shared by both twins so they cannot drift — the case-study pattern
// (src/lib/portfolio/casePage.ts).
//
// Everything starts in ONE round: the service (published, with its discipline embedded
// for the crumb and the title), the published disciplines with their services (the
// "More in {Discipline}" siblings AND the inquiry form's grouped select — one read serves
// both), and the head (identity + SEO defaults). Chained only on the service query: its
// case block and its `entity_seo` override, which need the service's id. So the page costs
// the service query plus one dependent read.
//
// null = no such PUBLISHED service (or a row the schema rejects). RLS also hides a service
// whose discipline is not published (0028 services_discipline_published), so archiving a
// discipline takes its pages down here without this file knowing.

export interface ServicePage {
  service: ServiceDetail;
  /** The service's discipline with its published services (the "More in" list), or null. */
  discipline: Discipline | null;
  /** Every published discipline with its services — the form's grouped select. */
  disciplines: Discipline[];
  /** The published case block; null hides the band (and the hero CTA skips to the form). */
  serviceCase: ServiceCase | null;
  head: Head;
}

type Locals = Parameters<typeof loadHead>[0];

/** The page's Tier-A tags: everything it renders, so a publish of any of it purges it. */
export function serviceCacheEntities(slug: string): string[] {
  return [
    `service:${slug}`,
    'services:all',
    'disciplines:all',
    'service_cases:all',
    'portfolio:all',
    'clients:all',
    'sectors:all',
    'media:all',
  ];
}

type TitleSource = Pick<ServiceDetail, 'title' | 'discipline'>;

/**
 * The `%s` of the title template: "Logo Design | Branding", which the brand-first site
 * template makes "Braiin Statiion | Logo Design | Branding" (src/lib/seo/title.ts). A
 * service not yet placed in a discipline is its name alone.
 */
export function serviceTitle(service: TitleSource, locale: Locale): string {
  const name = pickLocale(service.title, locale);
  const discipline = service.discipline ? pickLocale(service.discipline.name, locale) : '';
  return discipline ? `${name} | ${discipline}` : name;
}

/**
 * The meta description: the service's tagline, strictly in the page's language (no
 * English on an Arabic page), else the generic service-page line.
 */
export function serviceDescription(service: Pick<ServiceDetail, 'tagline'>, locale: Locale) {
  return pickLocaleStrict(service.tagline, locale) || SERVICE_PAGE_META[locale].description;
}

/**
 * The hero's sub line: the tagline, as the {en, ar} pair Hero's Text wants (a missing
 * Arabic half reads English, as pickLocale would have picked anyway). null for a service
 * with no tagline, and the hero then renders no sub (`data.noSub`) — never the home
 * slogan, which is what Hero shows when it is given none.
 */
export function serviceHeroSub(
  service: Pick<ServiceDetail, 'tagline'>,
): { en: string; ar: string } | null {
  const tagline = service.tagline;
  return tagline ? { en: tagline.en, ar: tagline.ar || tagline.en } : null;
}

/** The service's discipline among the published ones (its siblings), matched by id. */
export function disciplineOf(
  service: Pick<ServiceDetail, 'disciplineId' | 'discipline'>,
  disciplines: readonly Discipline[],
): Discipline | null {
  if (!service.disciplineId) return null;
  return (
    disciplines.find((d) => d.id === service.disciplineId) ??
    // The embedded discipline and the list agree on the slug even if ids were re-seeded.
    (service.discipline ? disciplines.find((d) => d.slug === service.discipline?.slug) : null) ??
    null
  );
}

export async function loadServicePage(
  slug: string,
  locals: Locals,
  locale: Locale,
): Promise<ServicePage | null> {
  const serviceQuery = getServiceBySlug(slug).then((row) => (row ? toServiceDetail(row) : null));
  const [service, disciplines, serviceCase, head] = await Promise.all([
    serviceQuery,
    getPublishedDisciplines(),
    serviceQuery.then((s) => (s ? getServiceCase(s.id) : null)),
    loadHead(locals, {
      locale,
      fallbackTitle: serviceQuery.then((s) => (s ? serviceTitle(s, locale) : '')),
      fallbackDescription: serviceQuery.then((s) => (s ? serviceDescription(s, locale) : '')),
      entity: serviceQuery.then((s) => (s ? { type: 'service' as const, id: s.id } : null)),
    }),
  ]);
  if (!service) return null;
  return {
    service,
    discipline: disciplineOf(service, disciplines),
    disciplines,
    serviceCase,
    head,
  };
}

/**
 * What the route answers for a slug:
 *   page      a published service (its own page — a restored retired slug included)
 *   redirect  a retired slug (301 to where it moved, src/lib/services/retired.ts)
 *   missing   anything else: a REAL 404 in the page's language (never another service's
 *             page — the mockup fell back to Logo Design for any unknown `?s=`)
 */
export type ServiceRoute =
  | { kind: 'page'; page: ServicePage }
  | { kind: 'redirect'; response: Response }
  | { kind: 'missing' };

export async function resolveServiceRoute(
  slug: string | undefined,
  locals: Locals,
  locale: Locale,
): Promise<ServiceRoute> {
  if (!slug) return { kind: 'missing' };
  const page = await loadServicePage(slug, locals, locale);
  if (page) return { kind: 'page', page };
  const response = retiredRedirect(slug, locale);
  return response ? { kind: 'redirect', response } : { kind: 'missing' };
}
