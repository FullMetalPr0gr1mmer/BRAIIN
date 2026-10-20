import { expect, test } from '@playwright/test';
import { ROUTES } from '../e2e/publicRoutes';
import { SKIP_REASON, authFile, staffEnv } from './staff';

// Preview parity (Admin v2 R9; releases.md §9, README "Preview": mandatory on every Tier A
// route). With nothing pending, the preview of a page IS the public page: the same markup
// from the first byte of <body> to the end of the footer, EN and AR, once the preview's own
// additions are taken out (the ribbon, the section markers) and so is what differs on every
// response anyway (the CSP nonce, scripts: the public page's telemetry and consent banner,
// the preview's bridge). The markup is compared as served, before any script runs.
//
// This is what holds R8's anon-RLS mirror (src/lib/preview/visibility.ts) and the overlay
// emulator honest against the real database: a fence the mirror misses shows up here as a
// section, a card or a link that one side has and the other does not.
//
// "Nothing pending" is made exact with a selection that names no change (`only=` a uuid no
// draft has): the drafts are still read, and none is laid over, so a sibling spec's draft
// (preview-isolation) cannot leak into this comparison.

test.skip(!staffEnv() && !process.env['CI'], SKIP_REASON);
test.use({ storageState: authFile('admin') });

const NOTHING = '00000000-0000-4000-8000-00000000e2e0';

/** `/about?x=1` → `/admin/preview/about?x=1&only=…`. */
function previewOf(route: string): string {
  const [path, query = ''] = route.split('?');
  const base = path === '/' ? '/admin/preview' : `/admin/preview${path}`;
  const params = new URLSearchParams(query);
  params.set('only', NOTHING);
  return `${base}?${params.toString()}`;
}

/** The page's own markup: <body> to the end of the footer, the differences named above out. */
function comparable(html: string): string {
  const start = html.search(/<body\b[^>]*>/i);
  const end = html.lastIndexOf('</footer>');
  expect(start, 'a <body>').toBeGreaterThan(-1);
  const body = html.slice(start, end === -1 ? html.indexOf('</body>') : end + '</footer>'.length);
  return body
    .replace(/<aside class="pv-ribbon"[\s\S]*?<\/aside>/, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/ data-pv-section="[^"]*"/g, '')
    .replace(/ nonce="[^"]*"/g, '')
    .replace(/ uid="[^"]*"/g, '');
}

for (const route of ROUTES) {
  test(`the preview of ${route} with nothing pending is the public page`, async ({ request }) => {
    const pub = await request.get(route, { maxRedirects: 0 });
    const pv = await request.get(previewOf(route), { maxRedirects: 0 });
    expect(pv.status(), 'the same status').toBe(pub.status());
    const pvHtml = await pv.text();
    // The ribbon's state is not asserted: R8's tripwire is isolate-wide (its D1), so a public
    // spec served by the same isolate during this render can mark it untrusted. The markup
    // below is the proof either way.
    expect(pvHtml, 'the preview says it is one').toContain('data-pv-ribbon');
    expect(pvHtml, 'with nothing pending').not.toMatch(/\d+ unpublished change/);
    expect(comparable(pvHtml)).toBe(comparable(await pub.text()));
  });
}
