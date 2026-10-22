import { describe, expect, test } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SeoHead from '@/components/SeoHead.astro';
import type { Identity } from '@/lib/identity/fallback';
import type { SiteIcons } from '@/lib/data/siteProfile';
import type { ImageRef } from '@/lib/media/resolve';
import { uploadedImage } from '@/lib/media/storageUrl';
import { IDENTITY } from './fixtures';
import { LOCALES, normalise } from './harness';

// The page head, <SeoHead>, to the byte (the F6 method). The snapshot was written by the
// component as it stood BEFORE Admin v2 U9 taught it the site's icons, so it is the proof that
// a site with no icon set (every site until the owner uploads one) serves the same head as
// before: no icon link, no apple-touch-icon, no manifest link. Then what does change: a
// favicon adds the two icon links, an app icon the apple-touch-icon and the manifest link.

const TENANT = '11111111-1111-4111-8111-111111111111';
const upload = (id: string, size: number): ImageRef => {
  const src = uploadedImage(`${TENANT}/${id}_${size}x${size}.webp`);
  if (!src) throw new Error('fixture upload did not resolve');
  return { id, src, width: size, height: size, alt: { en: '', ar: '' } };
};
const FAVICON = upload('22222222-2222-4222-8222-222222222222', 512);
const APP_ICON = upload('33333333-3333-4333-8333-333333333333', 1024);

async function render(
  locale: 'en' | 'ar',
  icons?: SiteIcons,
  identity: Identity = IDENTITY,
): Promise<string> {
  const container = await AstroContainer.create();
  const html = await container.renderToString(SeoHead, {
    props: {
      title: 'Logo design | Braiin',
      description: 'A mark that holds.',
      locale,
      logicalPath: '/services/logo',
    },
    request: new Request(`https://www.example.test${locale === 'ar' ? '/ar' : ''}/services/logo`),
    locals: {
      identity: Promise.resolve(identity),
      ...(icons ? { siteIcons: Promise.resolve(icons) } : {}),
    } as App.Locals,
  });
  return normalise(html);
}

describe('<SeoHead>, to the byte', () => {
  for (const locale of LOCALES) {
    test(`${locale}: with no icon set, the head is the one served before U9`, async () => {
      await expect(await render(locale)).toMatchSnapshot();
      // An identity naming no icon reads nothing, and says nothing.
      expect(await render(locale, { favicon: null, appIcon: null })).toBe(await render(locale));
    });
  }
});

describe('<SeoHead>, the icons (Admin v2 U9)', () => {
  test('a favicon: two PNG icon links, 32 and 192, through /_image', async () => {
    const html = await render('en', { favicon: FAVICON, appIcon: null });
    const links = [...html.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('type="image/png"');
    expect(links[0]).toContain('sizes="32x32"');
    expect(links[0]).toMatch(/href="\/_image\?[^"]*w=32[^"]*h=32[^"]*f=png/);
    expect(links[1]).toContain('sizes="192x192"');
    expect(links[1]).toMatch(/w=192[^"]*h=192[^"]*f=png/);
    expect(html).not.toContain('apple-touch-icon');
    expect(html).not.toContain('rel="manifest"');
  });

  test('an app icon: the apple-touch-icon at 180, and the manifest of the page language', async () => {
    const en = await render('en', { favicon: null, appIcon: APP_ICON });
    expect(en).toMatch(
      /<link rel="apple-touch-icon" sizes="180x180" href="\/_image\?[^"]*w=180[^"]*h=180[^"]*f=png[^"]*">/,
    );
    expect(en).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(en).not.toContain('rel="icon"');
    const ar = await render('ar', { favicon: null, appIcon: APP_ICON });
    expect(ar).toContain('<link rel="manifest" href="/ar/manifest.webmanifest">');
  });

  test('the icon links sit together, after the canonical and the alternates', async () => {
    const html = await render('en', { favicon: FAVICON, appIcon: APP_ICON });
    const canonical = html.indexOf('rel="canonical"');
    const firstIcon = html.indexOf('rel="icon"');
    const manifest = html.indexOf('rel="manifest"');
    const ogType = html.indexOf('og:type');
    expect(canonical).toBeGreaterThan(-1);
    expect(firstIcon).toBeGreaterThan(canonical);
    expect(manifest).toBeGreaterThan(firstIcon);
    expect(ogType).toBeGreaterThan(manifest);
  });
});
