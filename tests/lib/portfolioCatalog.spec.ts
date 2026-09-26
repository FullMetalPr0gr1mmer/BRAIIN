import { describe, it, expect } from 'vitest';
import type { PortfolioCard } from '@/lib/data/portfolio';
import {
  catalogueOrder,
  facetOptions,
  facetQuery,
  filterCards,
  isFiltered,
  latestOrder,
  nextProject,
  parseFacets,
} from '@/lib/portfolio/catalog';

// The one facet module behind Our Work and All projects. The query string is untrusted:
// these tests pin that only values a published project carries ever become a filter.

const t = (en: string) => ({ en, ar: `ع-${en}` });
let n = 0;
function card(over: Partial<PortfolioCard> = {}): PortfolioCard {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    slug: `p-${n}`,
    title: t(`P${n}`),
    projectType: null,
    blurb: null,
    year: 2025,
    isFeatured: false,
    sortOrder: n,
    updatedAt: null,
    poster: null,
    preview: null,
    sector: null,
    client: null,
    confidentialClient: false,
    services: [],
    ...over,
  };
}

const svc = (slug: string, order: number, label?: string) => ({
  slug,
  title: t(slug),
  label: t(label ?? slug),
  order,
});

const rider = card({
  slug: 'the-rider',
  year: 2026,
  isFeatured: true,
  sortOrder: 1,
  sector: { slug: 'automotive', name: t('Automotive'), order: 1 },
  client: { slug: 'client-a', name: t('Client A'), order: 1 },
  services: [svc('videography', 4), svc('advertising', 8)],
});
const kitchen = card({
  slug: 'kitchen-hours',
  year: 2026,
  isFeatured: true,
  sortOrder: 2,
  sector: { slug: 'food-and-beverage', name: t('F&B'), order: 2 },
  client: { slug: 'client-b', name: t('Client B'), order: 2 },
  services: [svc('advertising', 8), svc('photography', 5)],
});
const notebook = card({
  slug: 'notebook',
  year: 2025,
  sortOrder: 3,
  sector: { slug: 'education', name: t('Education'), order: 3 },
  client: null,
  confidentialClient: true,
  services: [svc('seo-geo-aeo', 11, 'SEO / GEO / AEO')],
});
const CARDS = [kitchen, notebook, rider];

const q = (s: string) => new URLSearchParams(s);

describe('parseFacets — known values only', () => {
  it('keeps a value some published project carries', () => {
    expect(parseFacets(q('service=advertising&year=2026'), CARDS)).toEqual({
      service: 'advertising',
      year: '2026',
    });
  });

  it('drops an unknown slug and a hostile year', () => {
    expect(parseFacets(q('service=nope&year=%3Cimg%20onerror%3Dx%3E'), CARDS)).toEqual({});
    expect(parseFacets(q('year=1999'), CARDS)).toEqual({}); // well-formed, but no project
  });

  it('takes the first value of a repeated key', () => {
    expect(parseFacets(q('sector=education&sector=automotive'), CARDS)).toEqual({
      sector: 'education',
    });
  });

  it('never offers a confidential client as a filter (naming it in a URL would disclose it)', () => {
    expect(facetOptions(CARDS, 'client').map((o) => o.value)).toEqual(['client-a', 'client-b']);
  });
});

describe('isFiltered — any facet key makes the response uncacheable', () => {
  it('is true for a valid, an invalid and an unknown-value facet', () => {
    expect(isFiltered(q('service=advertising'))).toBe(true);
    expect(isFiltered(q('year=<img>'))).toBe(true);
    expect(isFiltered(q('client=zzz'))).toBe(true);
  });

  it('is false for the bare URL, empty values and unrelated keys', () => {
    expect(isFiltered(q(''))).toBe(false);
    expect(isFiltered(q('service='))).toBe(false);
    expect(isFiltered(q('utm_source=x'))).toBe(false);
  });
});

describe('filtering and options', () => {
  it('applies every selected facet', () => {
    expect(filterCards(CARDS, { service: 'advertising' }).map((c) => c.slug)).toEqual([
      'kitchen-hours',
      'the-rider',
    ]);
    expect(filterCards(CARDS, { service: 'advertising', year: '2025' })).toEqual([]);
  });

  it('counts over the whole pool, in catalogue order, years newest first', () => {
    expect(facetOptions(CARDS, 'service')).toEqual([
      { value: 'videography', label: t('videography'), count: 1 },
      { value: 'photography', label: t('photography'), count: 1 },
      { value: 'advertising', label: t('advertising'), count: 2 },
      { value: 'seo-geo-aeo', label: t('SEO / GEO / AEO'), count: 1 }, // the short title
    ]);
    expect(facetOptions(CARDS, 'year').map((o) => [o.value, o.count])).toEqual([
      ['2026', 2],
      ['2025', 1],
    ]);
  });

  it('builds the query from the selection in a fixed order', () => {
    expect(facetQuery({ year: '2026', service: 'advertising' })).toBe(
      '?service=advertising&year=2026',
    );
    expect(facetQuery({})).toBe('');
  });
});

describe('orders', () => {
  it('All projects: featured first, then catalogue order', () => {
    const extra = card({ slug: 'z', sortOrder: 0 });
    expect(catalogueOrder([extra, notebook, kitchen, rider]).map((c) => c.slug)).toEqual([
      'the-rider',
      'kitchen-hours',
      'z',
      'notebook',
    ]);
  });

  it('Our Work latest: newest year first, then catalogue order', () => {
    expect(latestOrder([notebook, kitchen, rider]).map((c) => c.slug)).toEqual([
      'the-rider',
      'kitchen-hours',
      'notebook',
    ]);
  });
});

describe('nextProject', () => {
  it('follows the editor’s explicit choice when it is published', () => {
    expect(nextProject(CARDS, { id: rider.id, nextPortfolioId: notebook.id })?.slug).toBe(
      'notebook',
    );
  });

  it('otherwise the following project in catalogue order, wrapping round', () => {
    expect(nextProject(CARDS, { id: rider.id, nextPortfolioId: null })?.slug).toBe('kitchen-hours');
    expect(nextProject(CARDS, { id: notebook.id, nextPortfolioId: null })?.slug).toBe('the-rider');
  });

  it('ignores an unpublished or self choice, and is null when alone', () => {
    const ghost = '99999999-9999-4999-8999-999999999999';
    expect(nextProject(CARDS, { id: rider.id, nextPortfolioId: ghost })?.slug).toBe(
      'kitchen-hours',
    );
    expect(nextProject([rider], { id: rider.id, nextPortfolioId: rider.id })).toBeNull();
  });
});
