import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PortfolioCard } from '@/lib/data/portfolio';
import type { SectionData } from '@/lib/sections/types';

// The route loaders behind Our Work and All projects (src/lib/portfolio/pages.ts): which
// cards a filter is validated against, which sections receive route data, when the
// response must not be edge-cached, and the default compositions.

const t = (en: string) => ({ en, ar: `ع-${en}` });
const card = (slug: string, over: Partial<PortfolioCard> = {}): PortfolioCard => ({
  id: slug,
  slug,
  title: t(slug),
  projectType: null,
  blurb: null,
  year: 2025,
  isFeatured: false,
  sortOrder: 1,
  updatedAt: null,
  poster: null,
  preview: null,
  sector: null,
  client: null,
  confidentialClient: false,
  services: [],
  ...over,
});
const svc = (slug: string) => ({ slug, title: t(slug), label: t(slug), order: 1 });

const CARDS = [
  card('the-rider', { isFeatured: true, year: 2026, services: [svc('videography')] }),
  card('dust-trail', { services: [svc('social-media')] }),
];

let authored: SectionData[] = [];
vi.mock('@/lib/data/portfolio', () => ({ getPortfolioCards: async () => CARDS }));
vi.mock('@/lib/data/pageSections', () => ({
  getPageComposition: async (slug: string) => ({
    page: { id: `id-${slug}`, slug, title: t(slug), updatedAt: null },
    sections: authored,
  }),
}));
const entities: unknown[] = [];
vi.mock('@/lib/seo/head', () => ({
  loadHead: async (_locals: unknown, opts: { fallbackTitle: string; entity: unknown }) => {
    entities.push(await opts.entity);
    return { seo: { title: opts.fallbackTitle }, identity: {}, brand: 'B' };
  },
}));

const { loadOurWork, loadAllProjects } = await import('@/lib/portfolio/pages');
const url = (q = '') => new URL(`https://www.braiinstation.com/portfolio${q}`);
const byType = (sections: SectionData[], type: string) => sections.find((s) => s.type === type);

beforeEach(() => {
  authored = [];
  entities.length = 0;
});

describe('loadOurWork', () => {
  it('renders the default composition until the page is composed', async () => {
    const page = await loadOurWork(url(), {} as never, 'en');
    expect(page.sections.map((s) => s.type)).toEqual([
      'workHero',
      'proof',
      'workIntro',
      'projectGrid',
      'clientsMarquee',
      'cta',
    ]);
    expect(page.filtered).toBe(false);
  });

  it('validates the facet query against the FEATURED pool and injects it into the grid', async () => {
    // videography is on a featured project; social-media only on a non-featured one
    const kept = await loadOurWork(url('?service=videography'), {} as never, 'en');
    expect(byType(kept.sections, 'projectGrid')?.data).toMatchObject({
      selection: { service: 'videography' },
    });
    const dropped = await loadOurWork(url('?service=social-media'), {} as never, 'en');
    expect(byType(dropped.sections, 'projectGrid')?.data).toMatchObject({ selection: {} });
  });

  it('any facet parameter — valid or not — makes the response private (filtered)', async () => {
    expect(
      (await loadOurWork(url('?year=<img src=x onerror=alert(1)>'), {} as never, 'en')).filtered,
    ).toBe(true);
    expect((await loadOurWork(url('?utm_source=x'), {} as never, 'en')).filtered).toBe(false);
  });

  it('route data wins over authored content and reaches only its own section', async () => {
    authored = [
      { type: 'workHero', props: { tag: t('Latest') } },
      { type: 'projectGrid', props: {}, data: { cards: [] } },
      { type: 'cta', props: {} },
    ];
    const page = await loadOurWork(url(), {} as never, 'ar');
    expect(byType(page.sections, 'workHero')?.data).toEqual({ cards: CARDS });
    expect(byType(page.sections, 'projectGrid')?.data).toEqual({ cards: CARDS, selection: {} });
    expect(byType(page.sections, 'cta')?.data).toBeUndefined();
    expect(byType(page.sections, 'workHero')?.props).toEqual({ tag: t('Latest') });
  });

  it("keys the head's SEO override to the composed page, with a localised breadcrumb", async () => {
    const page = await loadOurWork(url(), {} as never, 'ar');
    expect(entities).toEqual([{ type: 'page', id: 'id-portfolio' }]);
    expect(page.head.seo.title).toBe('أعمالنا');
    expect(JSON.stringify(page.jsonLd)).toContain('https://www.braiinstation.com/ar/portfolio');
  });
});

describe('loadAllProjects', () => {
  it('renders head, catalogue and lead band by default, with the live count', async () => {
    const page = await loadAllProjects(url(), {} as never, 'en');
    expect(page.sections.map((s) => s.type)).toEqual(['pageHead', 'projectCatalog', 'cta']);
    expect(byType(page.sections, 'pageHead')?.data).toEqual({ count: 2 });
  });

  it('validates the query against the WHOLE catalogue and counts the matches', async () => {
    const page = await loadAllProjects(url('?service=social-media'), {} as never, 'en');
    expect(byType(page.sections, 'projectCatalog')?.data).toMatchObject({
      selection: { service: 'social-media' },
    });
    expect(byType(page.sections, 'pageHead')?.data).toEqual({ count: 1 });
    expect(page.filtered).toBe(true);
  });

  it('an unknown value filters nothing, but the response is still private', async () => {
    const page = await loadAllProjects(url('?client=nobody'), {} as never, 'en');
    expect(byType(page.sections, 'pageHead')?.data).toEqual({ count: 2 });
    expect(page.filtered).toBe(true);
  });

  it('breadcrumb: Home › Our Work › All projects', async () => {
    const page = await loadAllProjects(url(), {} as never, 'en');
    const names = (page.jsonLd[0] as { itemListElement: { name: string }[] }).itemListElement.map(
      (i) => i.name,
    );
    expect(names).toEqual(['Home', 'Our Work', 'All projects']);
  });
});
