import { describe, expect, it } from 'vitest';
import {
  EntitySeoWriteSchema,
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
