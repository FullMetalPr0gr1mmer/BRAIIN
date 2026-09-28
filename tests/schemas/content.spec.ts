import { describe, it, expect } from 'vitest';
import {
  LocalizedTextSchema,
  LocalizedProseSchema,
  ServiceRowSchema,
  PostRowSchema,
  TeamMemberRowSchema,
  StatisticRowSchema,
  PortfolioCardRowSchema,
  CaseStudyRowSchema,
  TestimonialRowSchema,
} from '@schemas/content';

// These schemas replaced a per-file `z.record(z.string(), z.string())`, which accepted
// `{}`, `{fr:'x'}` and — the actual defect — an Arabic-less `{en:'x'}`. The tests below
// are written against that specific regression: each one fails if the weak shape returns.

// `id` is required on the content row schemas: per-entity SEO (`entity_seo`) is keyed
// by uuid, so the public loaders select it.
const service = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'brand-identity',
  title: { en: 'Brand Identity', ar: 'الهوية البصرية' },
  short_title: null,
  blurb: null,
  body_html: null,
  hero_video_uid: null,
  category: null,
  is_teaser: false,
  sort_order: 1,
  updated_at: '2026-07-01T10:00:00Z', // feeds sitemap <lastmod> / dateModified
  // Round 2 (0028): the service-page fields. All empty is a valid (unplaced) service.
  discipline_id: null,
  intro: null,
  value_points: [],
  deliverables: [],
  preview_video_path: null,
  preview_start_s: null,
  preview_end_s: null,
  poster: null,
};

describe('LocalizedTextSchema — indexable scalars require Arabic', () => {
  it('accepts a genuinely bilingual value', () => {
    expect(LocalizedTextSchema.safeParse({ en: 'Branding', ar: 'العلامة التجارية' }).success).toBe(
      true,
    );
  });

  it('REJECTS an Arabic-less value (the z.record regression)', () => {
    expect(LocalizedTextSchema.safeParse({ en: 'Branding' }).success).toBe(false);
  });

  it('rejects an empty Arabic string — present-but-blank is not translated', () => {
    expect(LocalizedTextSchema.safeParse({ en: 'Branding', ar: '' }).success).toBe(false);
  });

  it('rejects an empty object', () => {
    expect(LocalizedTextSchema.safeParse({}).success).toBe(false);
  });
});

describe('LocalizedProseSchema — long-form prose may lag translation', () => {
  it('accepts EN-only prose (an in-progress Arabic body must not unpublish the post)', () => {
    expect(LocalizedProseSchema.safeParse({ en: '<p>Body</p>' }).success).toBe(true);
  });

  it('accepts both languages', () => {
    expect(LocalizedProseSchema.safeParse({ en: '<p>Body</p>', ar: '<p>نص</p>' }).success).toBe(
      true,
    );
  });

  it('still requires EN — a row with no readable text at all is invalid', () => {
    expect(LocalizedProseSchema.safeParse({ ar: '<p>نص</p>' }).success).toBe(false);
    expect(LocalizedProseSchema.safeParse({}).success).toBe(false);
  });
});

describe('content rows', () => {
  it('a fully bilingual service parses', () => {
    expect(ServiceRowSchema.safeParse(service).success).toBe(true);
  });

  it('a service whose title lacks Arabic is rejected, not silently half-rendered', () => {
    const arless = { ...service, title: { en: 'Brand Identity' } };
    expect(ServiceRowSchema.safeParse(arless).success).toBe(false);
  });

  it('rejects a malformed slug — slugs become URLs', () => {
    expect(ServiceRowSchema.safeParse({ ...service, slug: 'Brand Identity' }).success).toBe(false);
    expect(ServiceRowSchema.safeParse({ ...service, slug: 'brand_identity' }).success).toBe(false);
    expect(ServiceRowSchema.safeParse({ ...service, slug: 'brand-identity-2' }).success).toBe(true);
  });

  it('drops unrecognised locale keys rather than failing the row', () => {
    const parsed = LocalizedTextSchema.safeParse({ en: 'A', ar: 'ب', fr: 'C' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'fr' in parsed.data).toBe(false);
  });

  it('statistics keep the authored display value verbatim (suffixes survive)', () => {
    const parsed = StatisticRowSchema.safeParse({
      slug: 'projects-delivered',
      label: { en: 'Projects delivered', ar: 'المشاريع المنجزة' },
      value: '150+',
      sort_order: 1,
      value_numeric: 150,
      value_suffix: '+',
      placements: ['home'],
      placement_labels: {},
    });
    expect(parsed.success && parsed.data.value).toBe('150+');
  });

  it('a per-page statistic label must be bilingual too', () => {
    const base = {
      slug: 'brands',
      label: { en: 'Brands', ar: 'علامات' },
      value: '80+',
      sort_order: 2,
      value_numeric: 80,
      value_suffix: '+',
      placements: ['about'],
    };
    const ok = { about: { en: 'Brands we have partnered with', ar: 'علامات تعاونّا معها' } };
    expect(StatisticRowSchema.safeParse({ ...base, placement_labels: ok }).success).toBe(true);
    expect(
      StatisticRowSchema.safeParse({ ...base, placement_labels: { about: { en: 'Brands' } } })
        .success,
    ).toBe(false);
  });

  it('team member (E-E-A-T author) requires a bilingual name', () => {
    const base = {
      slug: 'lead-designer',
      bio: null,
      avatar_url: null,
      sort_order: 1,
      role: null,
      linkedin_url: null,
      is_leadership: false,
      is_placeholder: false,
      portrait: null,
    };
    expect(TeamMemberRowSchema.safeParse({ ...base, name: { en: 'Lead Designer' } }).success).toBe(
      false,
    );
    expect(
      TeamMemberRowSchema.safeParse({ ...base, name: { en: 'Lead Designer', ar: 'مصمم' } }).success,
    ).toBe(true);
  });

  it('a post accepts a null author embed but rejects an Arabic-less author name', () => {
    const post = {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'arabic-first-brand-systems',
      title: { en: 'Arabic-first brand systems', ar: 'أنظمة العلامات بالعربية أولاً' },
      excerpt: null,
      body_html: null,
      cover_image_url: null,
      published_at: '2026-06-10T09:00:00Z',
      updated_at: null,
      reading_minutes: 7,
      author: null,
      category: null,
    };
    expect(PostRowSchema.safeParse(post).success).toBe(true);

    const badAuthor = {
      ...post,
      author: { slug: 'lead-designer', name: { en: 'Lead Designer' }, avatar_url: null },
    };
    expect(PostRowSchema.safeParse(badAuthor).success).toBe(false);
  });
});

describe('UI v2 content rows', () => {
  const card = {
    id: '33333333-3333-4333-8333-333333333333',
    slug: 'the-rider',
    title: { en: 'The Rider', ar: 'الراكب' },
    project_type: { en: 'Brand film', ar: 'فيلم للعلامة' },
    teaser: null,
    summary: null,
    year: 2026,
    is_featured: true,
    sort_order: 1,
    updated_at: null,
    preview_video_uid: null,
    preview_video_path: '/media/showreel.mp4',
    preview_start_s: 1,
    preview_end_s: 3.7,
    client_id: '44444444-4444-4444-8444-444444444444',
    poster: null,
    sector: null,
    client: null,
    services: [],
  };

  it('a project card parses with a hidden client (null embed, client_id set)', () => {
    expect(PortfolioCardRowSchema.safeParse(card).success).toBe(true);
  });

  it('a card whose type lacks Arabic is rejected', () => {
    const bad = { ...card, project_type: { en: 'Brand film' } };
    expect(PortfolioCardRowSchema.safeParse(bad).success).toBe(false);
  });

  it('a case study bounds its lists as the database does', () => {
    const study = {
      ...card,
      body: null,
      lead: null,
      goal: null,
      result: null,
      scope: [],
      keywords: Array.from({ length: 7 }, () => ({ en: 'k', ar: 'ك' })),
      results: [],
      next_portfolio_id: null,
      media: [],
    };
    expect(CaseStudyRowSchema.safeParse(study).success).toBe(false);
    expect(CaseStudyRowSchema.safeParse({ ...study, keywords: [] }).success).toBe(true);
  });

  it('a testimonial row carries no consent fields (anon cannot read them)', () => {
    const keys = Object.keys(TestimonialRowSchema.shape);
    expect(keys).not.toContain('consent_obtained_at');
    expect(keys).not.toContain('consent_reference');
  });
});
