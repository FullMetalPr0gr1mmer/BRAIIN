import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishedCustomPage } from '@/lib/data/customPages';
import type { VisibilitySnapshot } from '@/lib/http/visibility';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// Custom pages in the discovery files (Admin v2 E11). The sitemap lists both language twins
// of every published custom page, with reciprocal alternates and the row's truthful lastmod;
// llms.txt lists each under the site's sections; both drop one that page visibility hides or
// whose SEO row says noindex, exactly as for the site's own pages. Supabase is unconfigured
// under test, so the two loaders are stubbed here to lock the wiring.

/** The origin, escaped for a RegExp (Node 22 has no RegExp.escape). */
const SITE_RE = SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STORY_ID = '00000000-0000-4000-8000-00000000e110';
const PAGES: PublishedCustomPage[] = [
  {
    id: STORY_ID,
    slug: 'our-story',
    title: { en: 'Our story', ar: 'قصتنا' },
    updatedAt: '2026-10-30T08:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-00000000e111',
    slug: 'how-we-work',
    title: { en: 'How we work', ar: 'كيف نشتغل' },
    updatedAt: null,
  },
];
let seoRules: unknown = null;

vi.mock('@/lib/data/customPages', () => ({ getPublishedCustomPages: async () => PAGES }));
vi.mock('@/lib/data/seo', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSeoRules: async () => seoRules,
}));

const { GET: sitemapGet } = await import('@/pages/sitemap.xml');
const { GET: llmsGet } = await import('@/pages/llms.txt');

type Handler = (ctx: { locals: object }) => Response | Promise<Response>;
const body = async (handler: unknown, locals: object = {}) =>
  await (await (handler as Handler)({ locals })).text();

const entry = (xml: string, path: string) =>
  xml.match(new RegExp(`<url><loc>${SITE_RE}${path}</loc>[\\s\\S]*?</url>`))?.[0];

afterEach(() => {
  seoRules = null;
});

describe('custom pages in the sitemap', () => {
  it('lists both twins of each, with reciprocal alternates and x-default to English', async () => {
    const xml = await body(sitemapGet);
    for (const slug of ['our-story', 'how-we-work']) {
      for (const path of [`/${slug}`, `/ar/${slug}`]) {
        const url = entry(xml, path);
        expect(url, path).toBeDefined();
        expect(url).toContain(`hreflang="en" href="${SITE}/${slug}"`);
        expect(url).toContain(`hreflang="ar" href="${SITE}/ar/${slug}"`);
        expect(url).toContain(`hreflang="x-default" href="${SITE}/${slug}"`);
      }
    }
  });

  it('carries the row’s lastmod, and none for a row without updated_at', async () => {
    const xml = await body(sitemapGet);
    expect(entry(xml, '/our-story')).toContain('<lastmod>2026-10-30</lastmod>');
    expect(entry(xml, '/ar/our-story')).toContain('<lastmod>2026-10-30</lastmod>');
    expect(entry(xml, '/how-we-work')).not.toContain('<lastmod>');
  });
});

describe('custom pages in llms.txt', () => {
  it('lists each by its English title under the sections', async () => {
    const text = await body(llmsGet);
    expect(text).toContain(`- Our story: ${SITE}/our-story`);
    expect(text).toContain(`- How we work: ${SITE}/how-we-work`);
  });
});

describe('a custom page that is not for crawlers leaves both files', () => {
  const snapshot = (pages: VisibilitySnapshot['pages']): VisibilitySnapshot => ({
    v: 1,
    builtAt: null,
    pages,
    templates: {},
  });

  it('hidden or link only (page visibility, by its slug)', async () => {
    for (const mode of [{ mode: 'hidden', target: null }, { mode: 'link' }] as const) {
      const visibility = snapshot({ 'our-story': mode });
      const xml = await body(sitemapGet, { visibility });
      expect(entry(xml, '/our-story'), mode.mode).toBeUndefined();
      expect(entry(xml, '/ar/our-story'), mode.mode).toBeUndefined();
      expect(entry(xml, '/how-we-work'), mode.mode).toBeDefined();
      const text = await body(llmsGet, { visibility });
      expect(text, mode.mode).not.toContain(`${SITE}/our-story`);
      expect(text, mode.mode).toContain(`${SITE}/how-we-work`);
    }
  });

  it('its own SEO row says noindex (the page’s row, found by its slug)', async () => {
    seoRules = {
      rules: [
        { entity_type: 'page', entity_id: STORY_ID, robots: 'noindex', canonical_override: null },
      ],
      pages: PAGES.map((p) => ({ id: p.id, slug: p.slug })),
    };
    const xml = await body(sitemapGet);
    expect(entry(xml, '/our-story')).toBeUndefined();
    expect(entry(xml, '/how-we-work')).toBeDefined();
    const text = await body(llmsGet);
    expect(text).not.toContain(`${SITE}/our-story`);
    expect(text).toContain(`${SITE}/how-we-work`);
  });
});
