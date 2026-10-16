import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VisibilitySnapshot } from '@/lib/http/visibility';
import { SEED_SERVICES, seedServiceRows } from '../fixtures/serviceSeeds';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

// The discovery files and page visibility (Admin v2 U14a). The sitemap and llms.txt list
// only public pages: a link-only or hidden page leaves both, and so does every page of a
// hidden template. With nothing hidden, both files are byte-identical to what they were
// before U14a: the snapshot below was written by main's versions of the two routes, then
// held against these.

vi.mock('@/lib/data/services', () => ({
  getPublishedServices: async () => seedServiceRows().slice(0, 3),
}));
vi.mock('@/lib/data/portfolio', () => ({
  getCaseStudyIndex: async () => [
    {
      slug: 'the-rider',
      title: { en: 'The Rider', ar: 'الراكب' },
      updatedAt: '2026-09-20T08:00:00Z',
    },
  ],
}));

const { GET: sitemapGet } = await import('@/pages/sitemap.xml');
const { GET: llmsGet } = await import('@/pages/llms.txt');

type Handler = (ctx: { locals: object }) => Response | Promise<Response>;
const body = async (handler: unknown, locals: object = {}) =>
  await (await (handler as Handler)({ locals })).text();

const snapshot = (
  pages: VisibilitySnapshot['pages'],
  templates: VisibilitySnapshot['templates'] = {},
): VisibilitySnapshot => ({ v: 1, builtAt: null, pages, templates });

const SERVICE = SEED_SERVICES[0]!.slug;

// llms.txt prints nothing dated, the sitemap nothing that moves: no clock to pin, but a
// fixed one keeps a hidden window's test exact.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('with nothing hidden, the bytes of before', () => {
  it('the sitemap', async () => {
    const xml = await body(sitemapGet);
    expect(xml).toMatchSnapshot();
    expect(await body(sitemapGet, { visibility: snapshot({}) })).toBe(xml);
  });

  it('llms.txt', async () => {
    const text = await body(llmsGet);
    expect(text).toMatchSnapshot();
    expect(await body(llmsGet, { visibility: snapshot({}) })).toBe(text);
  });
});

describe('a page that is not public leaves both files', () => {
  const s = snapshot(
    { about: { mode: 'link' }, join: { mode: 'hidden', target: 'contact' } },
    { service: { mode: 'hidden', target: null } },
  );

  it('the sitemap drops it, both twins, and every page of a hidden template', async () => {
    const xml = await body(sitemapGet, { visibility: s });
    for (const path of ['/about', '/join', `/services/${SERVICE}`]) {
      expect(xml).not.toContain(`<loc>${SITE}${path}</loc>`);
      expect(xml).not.toContain(`<loc>${SITE}/ar${path}</loc>`);
    }
    for (const path of ['/contact', '/services', '/portfolio/the-rider']) {
      expect(xml).toContain(`<loc>${SITE}${path}</loc>`);
    }
  });

  it('llms.txt drops its section line and the hidden template’s pages', async () => {
    const text = await body(llmsGet, { visibility: s });
    expect(text).not.toContain(`- About: ${SITE}/about`);
    expect(text).not.toContain(`- Join (careers): ${SITE}/join`);
    expect(text).toContain(`- Contact: ${SITE}/contact`);
    expect(text).not.toContain(`${SITE}/services/${SERVICE}`);
    expect(text).toContain(`${SITE}/portfolio/the-rider`);
  });

  it('a page hidden only from a later day is still listed today', async () => {
    const later = snapshot({
      about: { mode: 'hidden', target: null, from: '2026-12-01T00:00:00+03:00' },
    });
    expect(await body(sitemapGet, { visibility: later })).toContain(`<loc>${SITE}/about</loc>`);
    expect(await body(llmsGet, { visibility: later })).toContain(`- About: ${SITE}/about`);
  });
});
