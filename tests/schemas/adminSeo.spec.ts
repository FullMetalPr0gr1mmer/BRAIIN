import { describe, expect, it } from 'vitest';
import {
  CANONICAL_PATH_PATTERN,
  EntitySeoWriteSchema,
  SEO_DEFAULT_ROBOTS,
  SEO_DESCRIPTION_MAX,
  SEO_ROBOTS,
  SEO_TITLE_MAX,
  SHARE_IMAGE_URL_PATTERN,
  SeoDefaultsSchema,
  ShareImageUrlSchema,
} from '@schemas/admin';

// The share-image fields the SEO role writes — `entity_seo.og_image` (per page) and
// `seo_defaults.default_og_image` (the tenant default). Both reach every crawler that
// unfurls a link as og:image, so the write boundary takes only what the head can use: an
// https:// URL or a path on this site (made absolute by src/lib/seo/ogImage.ts).

const ACCEPTED = ['', 'https://cdn.test/og.jpg', 'https://cdn.test/a.jpg?w=1200&v=2', '/og/x.jpg'];
const REFUSED = [
  '//evil.test/og.jpg', // protocol-relative: another host
  '/\\evil.test/og.jpg', // the URL standard reads `/\host` as `//host`
  'http://cdn.test/og.jpg', // mixed content
  'javascript:alert(1)',
  'data:image/jpeg;base64,AAAA',
  'og/x.jpg', // not rooted
  '/og/a b.jpg', // whitespace
  `https://cdn.test/${'x'.repeat(2049 - 'https://cdn.test/'.length)}`, // 2049 characters
];

const entity = {
  entityType: 'service' as const,
  entityId: '11111111-1111-4111-8111-111111111111',
  metaTitle: { en: 'Logo Design', ar: 'تصميم الشعار' },
  metaDescription: { en: 'Marks.', ar: 'شعارات.' },
};

describe('ShareImageUrlSchema', () => {
  it.each(ACCEPTED)('accepts %j', (v) => {
    expect(ShareImageUrlSchema.safeParse(v).success).toBe(true);
  });

  it.each(REFUSED)('refuses %j', (v) => {
    expect(ShareImageUrlSchema.safeParse(v).success).toBe(false);
  });

  it('trims before it checks, and the pattern alone refuses an empty value', () => {
    expect(ShareImageUrlSchema.parse('  /og/x.jpg ')).toBe('/og/x.jpg');
    expect(SHARE_IMAGE_URL_PATTERN.test('')).toBe(false);
    expect(REFUSED.at(-1)).toHaveLength(2049);
  });
});

describe('both SEO write schemas use it', () => {
  it.each([...ACCEPTED, null, undefined])(
    'the entity override and the tenant default accept %j',
    (v) => {
      expect(EntitySeoWriteSchema.safeParse({ ...entity, ogImage: v }).success).toBe(true);
      expect(SeoDefaultsSchema.safeParse({ defaultOgImage: v, version: 1 }).success).toBe(true);
    },
  );

  it.each(REFUSED)('the entity override and the tenant default refuse %j', (v) => {
    expect(EntitySeoWriteSchema.safeParse({ ...entity, ogImage: v }).success).toBe(false);
    expect(SeoDefaultsSchema.safeParse({ defaultOgImage: v, version: 1 }).success).toBe(false);
  });
});

// ── Admin v2 U10: the pair rule, the caps, closed robots and canonical paths ──────────────

describe('EntitySeoWriteSchema (U10)', () => {
  const base = { entityType: 'service' as const, entityId: entity.entityId };
  const issuesOf = (input: unknown) => {
    const result = EntitySeoWriteSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
  };

  it('every field may be left to the page default (D4)', () => {
    expect(issuesOf(base)).toEqual([]);
    expect(issuesOf({ ...base, metaTitle: { en: '', ar: '' }, metaDescription: null })).toEqual([]);
  });

  it('a page may override only its title, or only its description (per pair)', () => {
    expect(issuesOf({ ...base, metaTitle: { en: 'Logo', ar: 'شعار' } })).toEqual([]);
    expect(issuesOf({ ...base, metaDescription: { en: 'Marks', ar: 'علامات' } })).toEqual([]);
  });

  it('a pair written in one language needs the other, named on the missing half', () => {
    expect(issuesOf({ ...base, metaTitle: { en: 'Logo', ar: '' } })).toEqual(['metaTitle.ar']);
    expect(issuesOf({ ...base, metaDescription: { en: ' ', ar: 'علامات' } })).toEqual([
      'metaDescription.en',
    ]);
  });

  it('caps a title at SEO_TITLE_MAX and a description at SEO_DESCRIPTION_MAX per language', () => {
    expect(SEO_TITLE_MAX).toBe(120);
    expect(SEO_DESCRIPTION_MAX).toBe(320);
    const title = (n: number) => ({ en: 'x'.repeat(n), ar: 'ع'.repeat(n) });
    expect(issuesOf({ ...base, metaTitle: title(120) })).toEqual([]);
    expect(issuesOf({ ...base, metaTitle: title(121) })).toContain('metaTitle.en');
    expect(issuesOf({ ...base, metaDescription: title(320) })).toEqual([]);
    expect(issuesOf({ ...base, metaDescription: title(321) })).toContain('metaDescription.ar');
  });

  it('robots is one of the closed per-page values, or null to follow the site', () => {
    expect(SEO_ROBOTS).toEqual(['index,follow', 'noindex,follow']);
    for (const robots of [...SEO_ROBOTS, null, undefined]) {
      expect(issuesOf({ ...base, robots }), String(robots)).toEqual([]);
    }
    for (const robots of ['noindex', 'noindex,nofollow', 'index, follow', 'all', '']) {
      expect(issuesOf({ ...base, robots }), robots).toEqual(['robots']);
    }
  });

  it.each(['/services/logo', '/', '/portfolio/all', '/arabic-type', '/about/'])(
    'a canonical override may be the site path %j',
    (canonicalOverride) => {
      expect(issuesOf({ ...base, canonicalOverride })).toEqual([]);
    },
  );

  it.each([
    '//evil.test/x',
    '/ar/services/logo',
    '/ar',
    '/ar/',
    'https://www.example.test/services/logo',
    '/a?b',
    '/a#b',
    '/\\x',
    'services/logo',
    '/a b',
    `/${'x'.repeat(2048)}`,
  ])('a canonical override refuses %j', (canonicalOverride) => {
    expect(issuesOf({ ...base, canonicalOverride })).toEqual(['canonicalOverride']);
  });

  it('the share image is a media id (a uuid), or null', () => {
    expect(issuesOf({ ...base, ogMediaId: entity.entityId })).toEqual([]);
    expect(issuesOf({ ...base, ogMediaId: null })).toEqual([]);
    expect(issuesOf({ ...base, ogMediaId: 'not-a-uuid' })).toEqual(['ogMediaId']);
  });

  it('the pattern is exported and agrees with the schema', () => {
    expect(CANONICAL_PATH_PATTERN.test('/x')).toBe(true);
    expect(CANONICAL_PATH_PATTERN.test('/ar/x')).toBe(false);
  });
});

describe('SeoDefaultsSchema (U10)', () => {
  it('robots is one of the closed site values', () => {
    expect(SEO_DEFAULT_ROBOTS).toEqual(['index,follow', 'noindex,follow', 'noindex,nofollow']);
    for (const robotsDirectives of SEO_DEFAULT_ROBOTS) {
      expect(SeoDefaultsSchema.safeParse({ robotsDirectives, version: 0 }).success).toBe(true);
    }
    for (const robotsDirectives of ['noindex', 'none', '']) {
      expect(SeoDefaultsSchema.safeParse({ robotsDirectives, version: 0 }).success).toBe(false);
    }
  });

  it('the default share image is a media id, or null', () => {
    expect(
      SeoDefaultsSchema.safeParse({ defaultOgMediaId: entity.entityId, version: 0 }).success,
    ).toBe(true);
    expect(SeoDefaultsSchema.safeParse({ defaultOgMediaId: null, version: 0 }).success).toBe(true);
    expect(SeoDefaultsSchema.safeParse({ defaultOgMediaId: 'x', version: 0 }).success).toBe(false);
  });
});
