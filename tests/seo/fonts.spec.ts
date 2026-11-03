import { readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { HERO_WEIGHTS, heroFontPreload, themedHeroWeight } from '@/lib/seo/fonts';

// The one hero-face preload per route (CLAUDE.md §6; docs/fonts.md). /ar/about's h1 is set at
// 600, which Almarai draws with its 700 face, and preloading 800 there let the 700 face swap in
// late and shift the heading (Lighthouse CLS 0.14 on /ar/about only). Since Admin v2 E13 a
// route names its heading's CSS weight (`heroWeight`), and the page's family (the brand's, or
// the theme's choice from the font catalogue: tests/lib/fontCatalogue.spec.ts) resolves it.

describe('hero-face preload', () => {
  it('EN is always the Archivo variable face, whatever weight the route names', () => {
    expect(heroFontPreload('en')).toBe('/fonts/archivo-var-latin.woff2');
    for (const weight of HERO_WEIGHTS) {
      expect(heroFontPreload('en', weight)).toBe('/fonts/archivo-var-latin.woff2');
    }
  });

  it('AR defaults to Home’s 800 face; About’s 600 heading renders with the 700 face', () => {
    expect(heroFontPreload('ar')).toBe('/fonts/almarai-800-arabic.woff2');
    expect(heroFontPreload('ar', 800)).toBe('/fonts/almarai-800-arabic.woff2');
    expect(heroFontPreload('ar', 700)).toBe('/fonts/almarai-700-arabic.woff2');
    expect(heroFontPreload('ar', 600)).toBe('/fonts/almarai-700-arabic.woff2');
  });

  it('every preloadable face exists and is inside the hero budget (35 KB Latin / 45 KB Arabic)', () => {
    const size = (href: string) => statSync(`public${href}`).size;
    for (const weight of HERO_WEIGHTS) {
      expect(size(heroFontPreload('en', weight)), `en ${weight}`).toBeLessThanOrEqual(35 * 1024);
      expect(size(heroFontPreload('ar', weight)), `ar ${weight}`).toBeLessThanOrEqual(45 * 1024);
    }
  });

  it('About names its 600 heading in both languages; no route names a family', () => {
    for (const page of ['src/pages/about.astro', 'src/pages/ar/about.astro']) {
      expect(readFileSync(page, 'utf8'), page).toContain('heroWeight={600}');
    }
    expect(readFileSync('src/layouts/BaseLayout.astro', 'utf8')).not.toMatch(/heroFace|almarai-/);
  });
});

describe('the preload follows the theme’s heading weight (Admin v2 E12)', () => {
  it('a Bold theme preloads the 700 face where the route’s heading is 800', () => {
    expect(themedHeroWeight(800, '700')).toBe(700);
    expect(heroFontPreload('ar', themedHeroWeight(800, '700'))).toBe(
      '/fonts/almarai-700-arabic.woff2',
    );
  });

  it('no theme, or the brand’s weight, keeps the route’s own; a heading not at 800 keeps it', () => {
    expect(themedHeroWeight(800, undefined)).toBe(800);
    expect(themedHeroWeight(800, '800')).toBe(800);
    expect(themedHeroWeight(700, '700')).toBe(700);
    expect(themedHeroWeight(600, '700')).toBe(600);
    expect(themedHeroWeight(600, undefined)).toBe(600);
  });

  it('BaseLayout hands SeoHead the face for the theme it links: its weight and its fonts', () => {
    const layout = readFileSync('src/layouts/BaseLayout.astro', 'utf8');
    expect(layout.replace(/\s+/g, ' ')).toContain(
      "heroFontPreload( locale, themedHeroWeight(heroWeight ?? 800, theme?.tokens['--bs-heading-weight']), theme?.tokens, )",
    );
    expect(layout).toMatch(/<SeoHead[\s\S]*?heroFont=\{heroFont\}[\s\S]*?\/>/);
    const head = readFileSync('src/components/SeoHead.astro', 'utf8');
    expect(head).toMatch(/rel="preload"\s+href=\{heroFont\}\s+as="font"/);
    expect(head.match(/rel="preload"/g)).toHaveLength(1);
  });
});
