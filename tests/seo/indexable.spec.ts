import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeoRuleRow } from '@/lib/data/seo';
import { indexability, isIndexedPath, LIST_EVERYTHING } from '@/lib/seo/indexable';
import type { VisibilitySnapshot } from '@/lib/http/visibility';
import { seedServiceRows } from '../fixtures/serviceSeeds';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// The sitemap and llms.txt leave out what the head hides (Admin v2 U10 D8): a URL whose
// effective robots is noindex (its SEO row's, else the site default), or whose canonical
// override names another path. Composed with page visibility (U14a), which runs first.

const BASE = SITE.replace(/\/$/, '');
const [S1, S2, S3] = seedServiceRows().slice(0, 3);
const PROJECT = '77777777-7777-4777-8777-000000000001';
const POST = '77777777-7777-4777-8777-000000000002';
const ABOUT = '77777777-7777-4777-8777-000000000003';

let rules: SeoRuleRow[] = [];
let defaultRobots = 'index,follow';
let seoReadFails = false;

vi.mock('@/lib/data/services', () => ({
  getPublishedServices: async () => seedServiceRows().slice(0, 3),
}));
vi.mock('@/lib/data/portfolio', () => ({
  getCaseStudyIndex: async () => [
    { id: PROJECT, slug: 'the-rider', title: { en: 'The Rider', ar: 'الراكب' }, updatedAt: null },
  ],
}));
vi.mock('@/lib/data/blog', () => ({
  getPublishedPosts: async () => [
    {
      id: POST,
      slug: 'hello',
      title: { en: 'Hello', ar: 'مرحبا' },
      updated_at: null,
    },
  ],
}));
vi.mock('@/lib/data/seo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/seo')>()),
  getSeoRules: async () =>
    seoReadFails ? null : { rules, pages: [{ id: ABOUT, slug: 'about' }] },
  getSeoDefaults: async () =>
    seoReadFails
      ? null
      : {
          title_template: {},
          default_title: {},
          default_description: {},
          default_og_image: null,
          robots_directives: defaultRobots,
        },
}));

const { GET: sitemapGet } = await import('@/pages/sitemap.xml');
const { GET: llmsGet } = await import('@/pages/llms.txt');

type Handler = (ctx: { locals: object }) => Response | Promise<Response>;
const body = async (handler: unknown, locals: object = {}) =>
  await (await (handler as Handler)({ locals })).text();

const rule = (over: Partial<SeoRuleRow>): SeoRuleRow => ({
  entity_type: 'service',
  entity_id: S1!.id,
  robots: null,
  canonical_override: null,
  ...over,
});

beforeEach(() => {
  rules = [];
  defaultRobots = 'index,follow';
  seoReadFails = false;
});

const listed = (xml: string, path: string) =>
  xml.includes(`<loc>${SITE}${path}</loc>`) &&
  xml.includes(`<loc>${SITE}${path === '/' ? '/ar' : `/ar${path}`}</loc>`);

describe('isIndexedPath', () => {
  it('lists everything when nothing is known (a failed read)', () => {
    expect(isIndexedPath(LIST_EVERYTHING, '/about', BASE)).toBe(true);
    expect(isIndexedPath(indexability(null, null), '/services/x', BASE)).toBe(true);
  });

  it('an explicit index outranks a noindex site default', () => {
    const ix = indexability(
      { rules: [rule({ robots: 'index,follow' })], pages: [] },
      'noindex,nofollow',
    );
    expect(isIndexedPath(ix, `/services/${S1!.slug}`, BASE, { type: 'service', id: S1!.id })).toBe(
      true,
    );
    expect(isIndexedPath(ix, `/services/${S2!.slug}`, BASE, { type: 'service', id: S2!.id })).toBe(
      false,
    );
    expect(isIndexedPath(ix, '/privacy', BASE)).toBe(false);
  });

  it('a legacy free-text noindex counts; a canonical equal to the page itself does not', () => {
    const ix = indexability(
      {
        rules: [
          rule({ robots: 'NOINDEX' }),
          rule({ entity_id: S2!.id, canonical_override: `/services/${S2!.slug}` }),
          rule({ entity_id: S3!.id, canonical_override: `${BASE}/ar/services/other` }),
        ],
        pages: [],
      },
      'index,follow',
    );
    const at = (s: typeof S1) =>
      isIndexedPath(ix, `/services/${s!.slug}`, BASE, { type: 'service', id: s!.id });
    expect(at(S1)).toBe(false);
    expect(at(S2)).toBe(true);
    expect(at(S3)).toBe(false);
  });
});

describe('the sitemap', () => {
  it('drops a noindex service, both twins', async () => {
    rules = [rule({ robots: 'noindex,follow' })];
    const xml = await body(sitemapGet);
    expect(listed(xml, `/services/${S1!.slug}`)).toBe(false);
    expect(listed(xml, `/services/${S2!.slug}`)).toBe(true);
  });

  it('drops a project and a post canonicalised onto another path', async () => {
    rules = [
      rule({ entity_type: 'portfolio', entity_id: PROJECT, canonical_override: '/portfolio' }),
      rule({ entity_type: 'blog_post', entity_id: POST, canonical_override: '/creative-knowledge' }),
    ];
    const xml = await body(sitemapGet);
    expect(listed(xml, '/portfolio/the-rider')).toBe(false);
    expect(listed(xml, '/creative-knowledge/hello')).toBe(false);
    expect(listed(xml, '/portfolio')).toBe(true);
  });

  it('a static route follows its page’s SEO row', async () => {
    rules = [rule({ entity_type: 'page', entity_id: ABOUT, robots: 'noindex,follow' })];
    const xml = await body(sitemapGet);
    expect(listed(xml, '/about')).toBe(false);
    expect(listed(xml, '/contact')).toBe(true);
  });

  it('a noindex site default empties it but for pages that ask to be indexed', async () => {
    defaultRobots = 'noindex,follow';
    rules = [rule({ robots: 'index,follow' })];
    const xml = await body(sitemapGet);
    expect(listed(xml, `/services/${S1!.slug}`)).toBe(true);
    for (const path of ['/', '/about', '/privacy', `/services/${S2!.slug}`]) {
      expect(listed(xml, path), path).toBe(false);
    }
  });

  it('a failed SEO read lists as before (the heads still say noindex)', async () => {
    seoReadFails = true;
    rules = [rule({ robots: 'noindex,follow' })];
    expect(listed(await body(sitemapGet), `/services/${S1!.slug}`)).toBe(true);
  });

  it('composes with page visibility: hidden there, never listed here', async () => {
    const visibility: VisibilitySnapshot = {
      v: 1,
      builtAt: null,
      pages: { contact: { mode: 'link' } },
      templates: {},
    };
    rules = [rule({ robots: 'index,follow' })];
    const xml = await body(sitemapGet, { visibility });
    expect(listed(xml, '/contact')).toBe(false);
    expect(listed(xml, `/services/${S1!.slug}`)).toBe(true);
  });
});

describe('llms.txt', () => {
  it('leaves out a noindex service, a canonicalised project and a hidden section', async () => {
    rules = [
      rule({ robots: 'noindex,follow' }),
      rule({ entity_type: 'portfolio', entity_id: PROJECT, canonical_override: '/portfolio' }),
      rule({ entity_type: 'page', entity_id: ABOUT, robots: 'noindex,follow' }),
    ];
    const text = await body(llmsGet);
    expect(text).not.toContain(`${SITE}/services/${S1!.slug}`);
    expect(text).toContain(`${SITE}/services/${S2!.slug}`);
    expect(text).not.toContain(`${SITE}/portfolio/the-rider`);
    expect(text).not.toContain(`- About: ${SITE}/about`);
    expect(text).toContain(`- Contact: ${SITE}/contact`);
  });
});
