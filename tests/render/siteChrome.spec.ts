import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SiteHeader from '@/components/SiteHeader.astro';
import SiteFooter from '@/components/SiteFooter.astro';
import { IDENTITY } from './fixtures';
import { LOCALES, normalise } from './harness';

// The header and the footer, the two components on every public page, rendered to the byte
// (the F6 method). The snapshot was written by the components as they stood BEFORE page
// visibility (Admin v2 U14a) taught them to leave out the pages that are not public, so it
// is the proof that a site with no visibility rows serves the same bytes as before.

const PATHS = ['/', '/about', '/services/logo'] as const;

// The footer prints the year: pinned, so the snapshot does not expire on 1 January.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

async function render(
  component: typeof SiteHeader,
  props: Record<string, unknown>,
  path: string,
): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(component, {
    props,
    request: new Request(`https://www.example.test${path}`),
    locals: { identity: Promise.resolve(IDENTITY) } as App.Locals,
  });
  return normalise(html);
}

describe('the site header and footer, to the byte', () => {
  for (const locale of LOCALES) {
    for (const path of PATHS) {
      const at = locale === 'ar' ? (path === '/' ? '/ar' : `/ar${path}`) : path;
      for (const variant of ['overlay', 'solid'] as const) {
        test(`header ${variant} on ${at}`, async () => {
          expect(await render(SiteHeader, { locale, variant }, at)).toMatchSnapshot();
        });
      }
      test(`footer on ${at}`, async () => {
        expect(await render(SiteFooter, { locale }, at)).toMatchSnapshot();
      });
    }
  }
});
