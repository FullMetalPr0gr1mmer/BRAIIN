import { expect, test } from '@playwright/test';
import { ROUTES, isArabic } from './publicRoutes';

/*
 * Served-markup gate for every public route, EN + AR.
 *
 * Generalises the scan that tests/e2e/contact-page.e2e.ts introduced for one page. It
 * asserts on the RESPONSE BODY, not the live DOM, because that is what CSP governs: a
 * `<style>` element or `style=` attribute in the response is silently dropped under our
 * no-'unsafe-inline' policy (the page renders unstyled, with only a console entry), while
 * CSSOM writes at runtime are legitimate and would make a DOM-based check fail for the
 * wrong reason.
 *
 * Every design delivery so far has arrived as standalone HTML full of exactly these
 * patterns (inline <style>/<script>, lenis from unpkg, Google Fonts, data: images, JS-built
 * content). This is the check that a port actually removed them — on every route, not
 * just the one the porter happened to look at. The routes are tests/e2e/publicRoutes.ts,
 * shared with the share-image gate.
 */

const BANNED: [RegExp, string][] = [
  [/<style[\s>]/i, 'inline <style> block'],
  [/\sstyle\s*=\s*["']/i, 'inline style attribute'],
  [/<[^>]+\son[a-z]+\s*=/i, 'inline event-handler attribute'],
  [/unpkg\.com/i, 'unpkg CDN reference'],
  [/fonts\.(googleapis|gstatic)\.com/i, 'Google Fonts reference'],
  [/\blenis\b/i, 'lenis smooth-scroll'],
  [/formspree/i, 'third-party form endpoint'],
  [/data:image\//i, 'data: image URI'],
  [/class\s*=\s*["'][^"']*\bsection-error\b/i, 'a section failed to render (SectionBoundary)'],
  // The legal copy's tokens are filled from the identity at render (src/lib/legal/render.ts,
  // design-port J-17); one reaching the page is a slot that bypassed the filler.
  [/%(?:brand|controller|mailbox)%/, 'unfilled legal-copy token'],
];

for (const route of ROUTES) {
  test(`served HTML is CSP-clean on ${route}`, async ({ request }) => {
    const res = await request.get(route);
    expect(res.status(), `${route} errored`).toBeLessThan(500);
    // A content slug that went missing must fail loudly, not quietly scan the 404 page.
    if (!route.endsWith('/404')) expect(res.status(), `${route} did not render`).toBe(200);
    const html = await res.text();
    for (const [pattern, what] of BANNED) {
      const hit = html.match(pattern);
      expect(hit?.[0] ?? null, `${what} in ${route}`).toBeNull();
    }
  });

  // Every <title> — legal pages included — carries the brand, in the page's language,
  // from the public identity (seeded: "Braiin Statiion" / "بريّن ستيشن"). A title
  // without it is a route that bypassed the title template (src/lib/seo/title.ts).
  test(`<title> and og:site_name carry the brand on ${route}`, async ({ request }) => {
    const html = await (await request.get(route)).text();
    const brand = isArabic(route) ? 'بريّن ستيشن' : 'Braiin Statiion';
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    expect(title, `title on ${route}`).toContain(brand);
    expect(html, `og:site_name on ${route}`).toContain(
      `<meta property="og:site_name" content="${brand}">`,
    );
  });

  test(`served HTML uses the current brand on ${route}`, async ({ request }) => {
    // Owner decision 1 (UI v2): "Braiin Statiion". The single-i "Station" spelling must
    // not reach any displayed string — the legal pages included, since their copy names the
    // brand and the controller from the identity (J-17) instead of spelling them; the
    // domain `braiinstation.com` is unaffected (this matches the two-word name only).
    const html = await (await request.get(route)).text();
    expect(html.match(/Braiin Station\b/g) ?? [], `old brand name on ${route}`).toHaveLength(0);
  });
}
