import { describe, it, expect } from 'vitest';
import {
  LocalizedTextSchema,
  LocalizedProseSchema,
  ServiceRowSchema,
  PostRowSchema,
  TeamMemberRowSchema,
  StatisticRowSchema,
} from '@schemas/content';

// These schemas replaced a per-file `z.record(z.string(), z.string())`, which accepted
// `{}`, `{fr:'x'}` and — the actual defect — an Arabic-less `{en:'x'}`. The tests below
// are written against that specific regression: each one fails if the weak shape returns.

const service = {
  slug: 'brand-identity',
  title: { en: 'Brand Identity', ar: 'الهوية البصرية' },
  blurb: null,
  body_html: null,
  hero_video_uid: null,
  category: null,
  is_teaser: false,
  sort_order: 1,
  updated_at: '2026-07-01T10:00:00Z', // feeds sitemap <lastmod> / dateModified
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
    });
    expect(parsed.success && parsed.data.value).toBe('150+');
  });

  it('team member (E-E-A-T author) requires a bilingual name', () => {
    const base = { slug: 'lead-designer', bio: null, avatar_url: null, sort_order: 1 };
    expect(TeamMemberRowSchema.safeParse({ ...base, name: { en: 'Lead Designer' } }).success).toBe(
      false,
    );
    expect(
      TeamMemberRowSchema.safeParse({ ...base, name: { en: 'Lead Designer', ar: 'مصمم' } }).success,
    ).toBe(true);
  });

  it('a post accepts a null author embed but rejects an Arabic-less author name', () => {
    const post = {
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
