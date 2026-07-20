import { describe, it, expect } from 'vitest';
import { GET as sitemapGet } from '@/pages/sitemap.xml';

const call = (h: unknown) => (h as unknown as () => Promise<Response>)();

// Supabase is unconfigured under test, so the loaders return [] and only the static
// routes appear. That is enough to lock the STRUCTURE — twins, alternates, and the
// lastmod policy — which is what regressed before.

const body = async () => await (await call(sitemapGet)).text();

describe('/sitemap.xml', () => {
  it('is valid-looking XML with the sitemap + xhtml namespaces', async () => {
    const xml = await body();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('lists BOTH language twins for every path (CLAUDE.md: both languages in the sitemap)', async () => {
    const xml = await body();
    for (const path of ['/services', '/portfolio', '/about', '/contact']) {
      expect(xml).toContain(`<loc>https://www.braiinstation.com${path}</loc>`);
      expect(xml).toContain(`<loc>https://www.braiinstation.com/ar${path}</loc>`);
    }
    // Home is the special case where /ar has no trailing path segment.
    expect(xml).toContain('<loc>https://www.braiinstation.com/</loc>');
    expect(xml).toContain('<loc>https://www.braiinstation.com/ar</loc>');
  });

  it('gives every URL reciprocal hreflang alternates plus x-default', async () => {
    const xml = await body();
    const urls = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toContain('hreflang="en"');
      expect(url).toContain('hreflang="ar"');
      expect(url).toContain('hreflang="x-default"');
    }
  });

  it('points x-default at the EN twin, never the AR one', async () => {
    const xml = await body();
    const xdefaults = xml.match(/hreflang="x-default" href="([^"]+)"/g) ?? [];
    expect(xdefaults.length).toBeGreaterThan(0);
    for (const d of xdefaults) expect(d).not.toContain('/ar');
  });

  it('OMITS lastmod for static routes rather than fabricating one', async () => {
    // The tempting bug is `new Date()`, which tells crawlers every URL changed on every
    // fetch. Static routes have no row and therefore no truthful lastmod, so they get
    // none. Pillar 3 asks for a TRUTHFUL dateModified, not a present one.
    const xml = await body();
    const homeEntry = (xml.match(
      /<url><loc>https:\/\/www\.braiinstation\.com\/<\/loc>[\s\S]*?<\/url>/,
    ) ?? [''])[0];
    expect(homeEntry).not.toContain('<lastmod>');
  });

  it('emits any lastmod it does emit as a W3C date', async () => {
    const xml = await body();
    for (const m of xml.match(/<lastmod>([^<]+)<\/lastmod>/g) ?? []) {
      expect(m).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    }
  });

  it('does not list noindex routes (/search) or private ones (/admin, /api)', async () => {
    const xml = await body();
    expect(xml).not.toContain('/search<');
    expect(xml).not.toContain('/admin');
    expect(xml).not.toContain('/api/');
  });

  it('is served as XML and carries a Cache-Tag so publish can purge it', async () => {
    const res = await call(sitemapGet);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(res.headers.get('cache-tag')).toContain('sitemap');
  });
});
