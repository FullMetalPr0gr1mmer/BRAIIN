import { describe, it, expect, vi } from 'vitest';

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
      expect(xml).toContain(`<loc>https://www.braiinstation.com/portfolio/${slug}</loc>`);
      expect(xml).toContain(`<loc>https://www.braiinstation.com/ar/portfolio/${slug}</loc>`);
    }
  });

  it('carries the row-truthful lastmod, and none for a row without updated_at', async () => {
    const xml = await (await call(sitemapGet)).text();
    const rider = xml.match(
      /<url><loc>https:\/\/www\.braiinstation\.com\/portfolio\/the-rider<\/loc>[\s\S]*?<\/url>/,
    )?.[0];
    expect(rider).toContain('<lastmod>2026-09-20</lastmod>');
    const notebook = xml.match(
      /<url><loc>https:\/\/www\.braiinstation\.com\/portfolio\/notebook<\/loc>[\s\S]*?<\/url>/,
    )?.[0];
    expect(notebook).not.toContain('<lastmod>');
  });

  it('llms.txt lists them under "Case studies", with no count', async () => {
    const body = await (await call(llmsGet)).text();
    const section = body.split('## Case studies')[1]?.split('\n## ')[0] ?? '';
    expect(section).toContain('- The Rider — https://www.braiinstation.com/portfolio/the-rider');
    expect(section).toContain('- Notebook — https://www.braiinstation.com/portfolio/notebook');
    expect(body).not.toMatch(/\d+\s+(projects|case studies)/i);
  });
});
