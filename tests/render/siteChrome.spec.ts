import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SiteHeader from '@/components/SiteHeader.astro';
import SiteFooter from '@/components/SiteFooter.astro';
import type { VisibilitySnapshot } from '@/lib/http/visibility';
import { IDENTITY } from './fixtures';
import { LOCALES, normalise } from './harness';

// The header and the footer, the two components on every public page, rendered to the byte
// (the F6 method). The snapshot was written by the components as they stood BEFORE page
// visibility (Admin v2 U14a) taught them to leave out the pages that are not public, so it
// is the proof that a site with no visibility rows serves the same bytes as before: with no
// snapshot, an empty one, or one that restricts only pages neither menu links to, every render
// equals it. Then what does change: a page that is not public leaves both menus.

const PATHS = ['/', '/about', '/services/logo'] as const;

// The footer prints the year: pinned, so the snapshot does not expire on 1 January.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const snapshot = (
  pages: VisibilitySnapshot['pages'],
  templates: VisibilitySnapshot['templates'] = {},
): VisibilitySnapshot => ({ v: 1, builtAt: null, pages, templates });

async function render(
  component: typeof SiteHeader,
  props: Record<string, unknown>,
  path: string,
  visibility?: VisibilitySnapshot,
): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(component, {
    props,
    request: new Request(`https://www.example.test${path}`),
    locals: {
      identity: Promise.resolve(IDENTITY),
      ...(visibility ? { visibility } : {}),
    } as App.Locals,
  });
  return normalise(html);
}

/** Snapshots that change nothing the two menus show (the fallback menus link no template child). */
const UNCHANGED: readonly VisibilitySnapshot[] = [
  snapshot({}),
  snapshot({}, { service: { mode: 'hidden', target: null } }),
  snapshot({}, { case_study: { mode: 'hidden', target: 'portfolio' } }),
  snapshot({ 'portfolio-all': { mode: 'link' } }),
  // Hidden from a later day: listed today.
  snapshot({ about: { mode: 'hidden', target: null, from: '2026-12-01T00:00:00+03:00' } }),
];

describe('the site header and footer, to the byte', () => {
  for (const locale of LOCALES) {
    for (const path of PATHS) {
      const at = locale === 'ar' ? (path === '/' ? '/ar' : `/ar${path}`) : path;
      for (const variant of ['overlay', 'solid'] as const) {
        test(`header ${variant} on ${at}`, async () => {
          const html = await render(SiteHeader, { locale, variant }, at);
          expect(html).toMatchSnapshot();
          for (const visibility of UNCHANGED) {
            expect(await render(SiteHeader, { locale, variant }, at, visibility)).toBe(html);
          }
        });
      }
      test(`footer on ${at}`, async () => {
        const html = await render(SiteFooter, { locale }, at);
        expect(html).toMatchSnapshot();
        for (const visibility of UNCHANGED) {
          expect(await render(SiteFooter, { locale }, at, visibility)).toBe(html);
        }
      });
    }
  }
});

describe('a page that is not public leaves both menus', () => {
  const s = snapshot({ about: { mode: 'link' }, join: { mode: 'hidden', target: 'contact' } });
  const links = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

  for (const locale of LOCALES) {
    const prefix = locale === 'ar' ? '/ar' : '';
    test(`header and footer, ${locale}`, async () => {
      const header = links(await render(SiteHeader, { locale }, `${prefix}/contact`, s));
      const footer = links(await render(SiteFooter, { locale }, `${prefix}/contact`, s));
      for (const list of [header, footer]) {
        expect(list).not.toContain(`${prefix}/about`);
        expect(list).not.toContain(`${prefix}/join`);
        expect(list).toContain(`${prefix}/contact`);
        expect(list).toContain(`${prefix}/services`);
      }
      // The legal links never leave the footer.
      expect(footer).toContain(`${prefix}/privacy`);
      // The language switch still points at this page's twin.
      expect(header).toContain(locale === 'ar' ? '/contact' : '/ar/contact');
    });
  }
});
