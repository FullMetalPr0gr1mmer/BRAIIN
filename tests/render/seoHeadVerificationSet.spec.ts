import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import SeoHead from '@/components/SeoHead.astro';
import { renderComponent } from './harness';

// The public <head> once a Search Console code is set (Admin v2 U11). Its twin,
// seoHeadVerification.spec.ts, holds the head with no code to the byte as it stood before
// U11; this one proves what a code adds: exactly one `google-site-verification` meta, after
// the robots meta, on an indexable home page in either language, and nothing anywhere else.
// The loader is stubbed here (a vi.mock is per file), so the read is counted too: a page
// that cannot carry the tag never asks for it. The identity is wrapped so a test can hold it:
// the read must start before the head awaits anything, so that it overlaps the reads the rest
// of the layout starts (the header's and footer's navigation) instead of following them.

const CODE = 'abcDEF012_-xyzVerification';
const getSearchConsoleToken = vi.fn<() => Promise<string | null>>();

vi.mock('@/lib/data/siteVerification', () => ({
  getSearchConsoleToken: () => getSearchConsoleToken(),
}));

const identityGate = vi.hoisted(() => ({ held: null as Promise<void> | null }));
vi.mock('@/lib/identity', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/identity')>();
  return {
    ...real,
    getIdentity: async (locals: Parameters<typeof real.getIdentity>[0]) => {
      if (identityGate.held) await identityGate.held;
      return real.getIdentity(locals);
    },
  };
});

const ROBOTS = '<meta name="robots" content="index,follow">';
const TAG = (code: string) => `<meta name="google-site-verification" content="${code}">`;

const HOME = { title: 'Home', description: 'A studio.', logicalPath: '/' } as const;

beforeEach(() => {
  getSearchConsoleToken.mockReset();
});

describe('the verification tag', () => {
  test.each(['en', 'ar'] as const)(
    'an indexable home page (%s) carries it after the robots meta, and nothing else moves',
    async (locale) => {
      getSearchConsoleToken.mockResolvedValueOnce(null);
      const without = await renderComponent(SeoHead, { ...HOME, locale });
      getSearchConsoleToken.mockResolvedValueOnce(CODE);
      const withCode = await renderComponent(SeoHead, { ...HOME, locale });
      expect(without).not.toContain('google-site-verification');
      expect(withCode).toBe(without.replace(ROBOTS, ROBOTS + TAG(CODE)));
      expect(withCode.split('google-site-verification')).toHaveLength(2);
      expect(getSearchConsoleToken).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    ['about', { title: 'About', description: 'Who.', locale: 'en', logicalPath: '/about' }],
    ['about, Arabic', { title: 'من نحن', description: 'من.', locale: 'ar', logicalPath: '/about' }],
    [
      'services',
      { title: 'Services', description: 'What.', locale: 'en', logicalPath: '/services' },
    ],
    ['a noindex home', { ...HOME, locale: 'en', description: '', robots: 'noindex,follow' }],
    [
      'search, noindex',
      {
        title: 'Search',
        description: '',
        locale: 'en',
        logicalPath: '/search',
        robots: 'noindex,follow',
      },
    ],
  ])('%s neither carries it nor reads it', async (_name, props) => {
    getSearchConsoleToken.mockResolvedValue(CODE);
    const html = await renderComponent(SeoHead, { ...props });
    expect(html).not.toContain('google-site-verification');
    expect(getSearchConsoleToken).not.toHaveBeenCalled();
  });

  test('no preview carries it: the layout makes every preview noindex, so it is never read', async () => {
    // src/lib/preview/dataset.ts and the U11 as-built say so: whoever previews, the dataset's
    // site_integrations row (Admin's and SEO's) never reaches a tag.
    const layout = readFileSync('src/layouts/BaseLayout.astro', 'utf8');
    expect(layout).toContain("const robotsValue = preview ? 'noindex,nofollow' : robots;");
    expect(layout).toContain('robots={robotsValue}');
    getSearchConsoleToken.mockResolvedValue(CODE);
    const html = await renderComponent(SeoHead, {
      ...HOME,
      locale: 'en',
      robots: 'noindex,nofollow',
    });
    expect(html).not.toContain('google-site-verification');
    expect(getSearchConsoleToken).not.toHaveBeenCalled();
  });

  test('the read starts before the head awaits anything, the identity included', async () => {
    let release: () => void = () => {};
    identityGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      getSearchConsoleToken.mockResolvedValueOnce(CODE);
      const rendering = renderComponent(SeoHead, { ...HOME, locale: 'en' });
      // The identity is still held, and the head has already asked for the code.
      await vi.waitFor(() => expect(getSearchConsoleToken).toHaveBeenCalledTimes(1));
      release();
      expect(await rendering).toContain(TAG(CODE));
    } finally {
      release();
      identityGate.held = null;
    }
  });

  test('a value stays inside its quoted attribute, never markup of its own', async () => {
    // The loader and the CHECK refuse such a value first; the head escapes it anyway. Astro
    // escapes the quote and the ampersand, so the value cannot close the attribute (an angle
    // bracket inside a quoted attribute is text).
    getSearchConsoleToken.mockResolvedValueOnce('a"b<c>&d');
    const html = await renderComponent(SeoHead, { ...HOME, locale: 'en' });
    expect(html).toContain('<meta name="google-site-verification" content="a&quot;b<c>&amp;d">');
    expect(html).not.toContain('content="a"');
  });
});
