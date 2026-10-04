import { describe, it, expect, vi } from 'vitest';
import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client';

/** The origin, escaped for a RegExp (Node 22 has no RegExp.escape). */
const SITE_RE = SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The sitemap and llms.txt list case studies from getCaseStudyIndex — the case-study
// page's own select + schema — so neither can list a URL the page would 404 on. Supabase
// is unconfigured under test, so the index is stubbed here to lock the wiring: both files
// read it, and both list exactly what it returns.

vi.mock('@/lib/data/portfolio', () => ({
  getCaseStudyIndex: async () => [
    {
      slug: 'the-rider',
      title: { en: 'The Rider', ar: 'الراكب' },
      updatedAt: '2026-09-20T08:00:00Z',
    },
    { slug: 'notebook', title: { en: 'Notebook', ar: 'الدفتر' }, updatedAt: null },
  ],
}));

const { GET: sitemapGet } = await import('@/pages/sitemap.xml');
const { GET: llmsGet } = await import('@/pages/llms.txt');

const call = async (handler: unknown) =>
  await (handler as unknown as (ctx: { locals: object }) => Response | Promise<Response>)({
    locals: {},
  });

describe('case studies in the discovery files', () => {
  it('the sitemap lists both language twins of every indexed case study', async () => {
    const xml = await (await call(sitemapGet)).text();
    for (const slug of ['the-rider', 'notebook']) {
      expect(xml).toContain(`<loc>${SITE}/portfolio/${slug}</loc>`);
      expect(xml).toContain(`<loc>${SITE}/ar/portfolio/${slug}</loc>`);
    }
  });

  it('carries the row-truthful lastmod, and none for a row without updated_at', async () => {
    const xml = await (await call(sitemapGet)).text();
    const entry = (slug: string) =>
      xml.match(new RegExp(`<url><loc>${SITE_RE}/portfolio/${slug}</loc>[\\s\\S]*?</url>`))?.[0];
    const rider = entry('the-rider');
    expect(rider).toContain('<lastmod>2026-09-20</lastmod>');
    const notebook = entry('notebook');
    expect(notebook).not.toContain('<lastmod>');
  });

  it('llms.txt lists them under "Case studies", with no count', async () => {
    const body = await (await call(llmsGet)).text();
    const section = body.split('## Case studies')[1]?.split('\n## ')[0] ?? '';
    expect(section).toContain(`- The Rider — ${SITE}/portfolio/the-rider`);
    expect(section).toContain(`- Notebook — ${SITE}/portfolio/notebook`);
    expect(body).not.toMatch(/\d+\s+(projects|case studies)/i);
  });
});
