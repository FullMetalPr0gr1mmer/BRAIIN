import { describe, it, expect, vi } from 'vitest';
import type { CaseStudyRow, PortfolioMediaRow } from '@schemas/content';

// Row → view-model mapping for the UI v2 portfolio loaders. The registry lookup is stubbed:
// what matters here is which provider/key reaches a page, not Vite's asset pipeline.

vi.mock('@/lib/media/static', () => ({
  staticImage: (key: string) =>
    key === 'stills/work/p0.jpg' ? { src: '/_astro/p0.jpg', width: 1280, height: 720 } : null,
}));

// A minimal PostgREST stand-in: every filter is recorded, and the rows are filtered by the
// `slug` equality the case-study query applies — enough to drive the page loader and the
// discovery index through the SAME code path they run in production.
let tableRows: unknown[] = [];
vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({
    from: () => {
      const filters: Record<string, unknown> = {};
      const result = () => {
        const rows = tableRows.filter(
          (r) => filters.slug === undefined || (r as { slug: unknown }).slug === filters.slug,
        );
        return { data: rows, error: null };
      };
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filters[col] = v;
          return q;
        },
        order: () => q,
        maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
      };
      return q;
    },
  }),
}));

const { toCard, toCaseStudy, getCaseStudy, getCaseStudyIndex } =
  await import('@/lib/data/portfolio');

const t = (en: string) => ({ en, ar: `ع-${en}` });
const media = (over: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  kind: 'image',
  provider: 'static' as const,
  storage_path: 'stills/work/p0.jpg',
  width: 10,
  height: 10,
  alt: { en: 'A rider at dawn', ar: 'راكب عند الفجر' },
  stream_uid: null,
  ...over,
});

const row: CaseStudyRow = {
  id: '33333333-3333-4333-8333-333333333333',
  slug: 'the-rider',
  title: t('The Rider'),
  project_type: t('Brand film'),
  teaser: null,
  summary: { en: 'The brief was…' },
  year: 2026,
  is_featured: true,
  sort_order: 1,
  updated_at: null,
  preview_video_uid: null,
  preview_video_path: '/media/showreel.mp4',
  preview_start_s: 1,
  preview_end_s: 3.7,
  client_id: '44444444-4444-4444-8444-444444444444',
  poster: media(),
  sector: { slug: 'automotive', name: t('Automotive'), sort_order: 1 },
  client: null,
  services: [
    {
      sort_order: 1,
      service: { slug: 'advertising', title: t('Advertising'), short_title: null, sort_order: 8 },
    },
    {
      sort_order: 0,
      service: { slug: 'seo-geo-aeo', title: t('SEO long'), short_title: t('SEO'), sort_order: 11 },
    },
    { sort_order: 2, service: null }, // an unpublished service: RLS returned null
  ],
  body_html: null,
  lead: t('A launch film…'),
  goal: null,
  result: null,
  scope: [],
  keywords: [t('Launch')],
  results: [{ value: 'XXM', label: t('Views') }],
  next_portfolio_id: null,
  media: [],
};

const item = (over: Partial<PortfolioMediaRow>): PortfolioMediaRow => ({
  role: 'gallery',
  kind: 'image',
  video_uid: null,
  video_path: null,
  clip_start_s: null,
  clip_end_s: null,
  duration_label: null,
  caption: null,
  breakdown_kind: null,
  layout: null,
  sort_order: 0,
  asset: media(),
  ...over,
});

describe('toCard', () => {
  const c = toCard(row);

  it('falls back from teaser to summary for the blurb', () => {
    expect(c.blurb).toEqual({ en: 'The brief was…' });
  });

  it('marks a client RLS hid as confidential (client_id set, embed null)', () => {
    expect(c.client).toBeNull();
    expect(c.confidentialClient).toBe(true);
    expect(toCard({ ...row, client_id: null }).confidentialClient).toBe(false);
  });

  it('keeps services in the editor’s order, drops hidden ones, labels with the short title', () => {
    expect(c.services.map((s) => [s.slug, s.label.en])).toEqual([
      ['seo-geo-aeo', 'SEO'],
      ['advertising', 'Advertising'],
    ]);
  });

  it('resolves a static poster from the registry — dimensions from the file, not the row', () => {
    expect(c.poster).toMatchObject({ width: 1280, height: 720, alt: { en: 'A rider at dawn' } });
  });

  it('never renders an unknown key, an external URL or a non-image', () => {
    expect(
      toCard({ ...row, poster: media({ storage_path: 'stills/work/nope.jpg' }) }).poster,
    ).toBeNull();
    expect(toCard({ ...row, poster: media({ provider: 'external' }) }).poster).toBeNull();
    expect(toCard({ ...row, poster: media({ kind: 'video' }) }).poster).toBeNull();
  });

  it('validates the preview clip (a window over 30 s is not played)', () => {
    expect(c.preview).toEqual({ path: '/media/showreel.mp4', startS: 1, endS: 3.7 });
    expect(toCard({ ...row, preview_end_s: 40 }).preview).toBeNull();
    expect(toCard({ ...row, preview_video_path: null }).preview).toBeNull();
  });
});

describe('toCaseStudy', () => {
  it('splits the media set by role, in order, dropping images that do not resolve', () => {
    const study = toCaseStudy({
      ...row,
      media: [
        item({ role: 'gallery', sort_order: 1 }),
        item({ role: 'gallery', sort_order: 0, caption: t('first') }),
        item({ role: 'gallery', sort_order: 2, asset: media({ storage_path: 'stills/x.jpg' }) }),
        item({
          role: 'hero',
          kind: 'video',
          video_path: '/media/showreel.mp4',
          clip_start_s: 1,
          clip_end_s: 3.7,
        }),
        item({ role: 'breakdown', breakdown_kind: 'sketch', layout: 'half' }),
      ],
    });
    expect(study.gallery).toHaveLength(2);
    expect(study.gallery[0]?.caption).toEqual(t('first'));
    expect(study.hero?.clip).toEqual({ path: '/media/showreel.mp4', startS: 1, endS: 3.7 });
    expect(study.final).toBeNull();
    expect(study.breakdown[0]).toMatchObject({ breakdownKind: 'sketch', layout: 'half' });
  });
});

describe('case-study stills are content: alt is required (PR11)', () => {
  it('drops a gallery/breakdown still that cannot be described in both languages', () => {
    const study = toCaseStudy({
      ...row,
      media: [
        item({ role: 'gallery', sort_order: 0 }),
        item({ role: 'gallery', sort_order: 1, asset: media({ alt: { en: 'Only English' } }) }),
        item({ role: 'gallery', sort_order: 2, asset: media({ alt: null }), caption: t('Cap') }),
        item({ role: 'breakdown', sort_order: 0, asset: media({ alt: null }) }),
      ],
    });
    // the bilingual alt and the captioned one stay; the half-described and the bare go
    expect(study.gallery).toHaveLength(2);
    expect(study.gallery[1]?.caption).toEqual(t('Cap'));
    expect(study.breakdown).toHaveLength(0);
  });
});

describe('the discovery index lists exactly what the case-study page renders', () => {
  const invalid = {
    ...row,
    id: '66666666-6666-4666-8666-666666666666',
    slug: 'broken',
    title: { en: 'No Arabic' },
  };

  it('a row the page rejects (404) is not in the index; a row it renders is', async () => {
    tableRows = [row, invalid];
    const index = await getCaseStudyIndex();
    expect(index.map((e) => e.slug)).toEqual(['the-rider']);
    expect(await getCaseStudy('the-rider')).not.toBeNull();
    expect(await getCaseStudy('broken')).toBeNull();
    for (const entry of index) expect(await getCaseStudy(entry.slug)).not.toBeNull();
  });

  it('an unknown slug is null (the route answers a real 404)', async () => {
    tableRows = [row];
    expect(await getCaseStudy('nope')).toBeNull();
  });
});
