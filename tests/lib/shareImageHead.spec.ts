import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicMediaRow } from '@schemas/content';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { ogImageCandidates, resolveOgImage } from '@/lib/seo/ogImage';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// A share image from the media library (Admin v2 U10, 0073) reaches the head: loadHead makes
// the SEO row's picture and the defaults' picture into absolute `/_image` JPEG URLs at most
// 1200 px wide (src/lib/seo/shareImage.ts; the unit stub of astro:assets builds Astro's URL
// shape), and the precedence (D2) is: the row's picture, its legacy link, the page's own
// image, the default picture, the default link, the logo card.

const TENANT = '11111111-1111-4111-8111-111111111111';
const upload = (id: string, w: number, h: number): PublicMediaRow => ({
  id,
  kind: 'image',
  provider: 'storage',
  storage_path: `${TENANT}/${id}_${w}x${h}.webp`,
  width: w,
  height: h,
  alt: { en: 'A picture', ar: 'صورة' },
  stream_uid: null,
});
const WIDE = upload('22222222-2222-4222-8222-222222222222', 2400, 1260);
const SMALL = upload('33333333-3333-4333-8333-333333333333', 800, 800);
const EXTERNAL: PublicMediaRow = { ...SMALL, provider: 'external', storage_path: 'https://x/y' };

let entityMedia: PublicMediaRow | null = null;
let entityLink: string | null = null;
let defaultMedia: PublicMediaRow | null = null;
let defaultLink: string | null = null;

vi.mock('@/lib/data/siteProfile', () => ({ getSiteProfile: async () => IDENTITY_FALLBACK }));
vi.mock('@/lib/data/seo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/seo')>()),
  getEntitySeo: async () => ({
    meta_title: null,
    meta_description: null,
    og_image: entityLink,
    og_media: entityMedia,
    canonical_override: null,
    robots: null,
    schema_type: null,
  }),
  getSeoDefaults: async () => ({
    title_template: {},
    default_title: {},
    default_description: {},
    default_og_image: defaultLink,
    default_og_media: defaultMedia,
    robots_directives: 'index,follow',
  }),
}));

const { loadHead } = await import('@/lib/seo/head');

beforeEach(() => {
  entityMedia = null;
  entityLink = null;
  defaultMedia = null;
  defaultLink = null;
});

/** What SeoHead would emit as og:image for a page whose own image is `own`. */
async function ogImage(own?: string) {
  const { seo } = await loadHead(
    {},
    { locale: 'en', fallbackTitle: 'Logo', entity: { type: 'service', id: 's1' } },
  );
  return resolveOgImage(ogImageCandidates(seo, own), {
    base: SITE,
    locale: 'en',
    brand: 'Braiin Statiion',
  }).url;
}

const imageUrl = (row: PublicMediaRow, width: number) => {
  const href = `https://example.supabase.co/storage/v1/object/public/media/${row.storage_path}`;
  return new URL(
    `/_image?${new URLSearchParams({ href, w: String(width), f: 'jpg' }).toString()}`,
    `${SITE.replace(/\/$/, '')}/`,
  ).href;
};

describe('the share image in the head (U10 D2)', () => {
  it('the SEO row’s picture wins, as an absolute JPEG at most 1200 px wide', async () => {
    entityMedia = WIDE;
    entityLink = 'https://cdn.test/legacy.jpg';
    defaultMedia = SMALL;
    expect(await ogImage(`${SITE}/own.jpg`)).toBe(imageUrl(WIDE, 1200));
  });

  it('a picture narrower than 1200 px keeps its own width (no upscale, native aspect)', async () => {
    entityMedia = SMALL;
    expect(await ogImage()).toBe(imageUrl(SMALL, 800));
  });

  it('then the row’s legacy link, then the page’s own image', async () => {
    entityLink = 'https://cdn.test/legacy.jpg';
    defaultMedia = SMALL;
    expect(await ogImage(`${SITE}/own.jpg`)).toBe('https://cdn.test/legacy.jpg');
    entityLink = null;
    expect(await ogImage(`${SITE}/own.jpg`)).toBe(`${SITE}/own.jpg`);
  });

  it('then the default picture, then the default link, then the logo card', async () => {
    defaultMedia = SMALL;
    defaultLink = 'https://cdn.test/default.jpg';
    expect(await ogImage()).toBe(imageUrl(SMALL, 800));
    defaultMedia = null;
    expect(await ogImage()).toBe('https://cdn.test/default.jpg');
    defaultLink = null;
    expect(await ogImage()).toBe(`${SITE.replace(/\/$/, '')}/og/default.jpg`);
  });

  it('a picture of a provider a page cannot render is skipped, never emitted', async () => {
    entityMedia = EXTERNAL;
    defaultMedia = EXTERNAL;
    expect(await ogImage(`${SITE}/own.jpg`)).toBe(`${SITE}/own.jpg`);
  });
});
