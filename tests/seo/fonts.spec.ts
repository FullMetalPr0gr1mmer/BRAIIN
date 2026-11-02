import { readFileSync, statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { HERO_FACES, heroFontPreload, themedHeroFace } from '@/lib/seo/fonts';

// The one hero-face preload per route (CLAUDE.md §6; docs/fonts.md). /ar/about's h1 renders
// with Almarai 700, and preloading 800 there let the 700 face swap in late and shift the
// heading (Lighthouse CLS 0.14 on /ar/about only).

describe('hero-face preload', () => {
  it('EN is always the Archivo variable face, whatever the route asks for', () => {
    expect(heroFontPreload('en')).toBe('/fonts/archivo-var-latin.woff2');
    expect(heroFontPreload('en', 'almarai-700')).toBe('/fonts/archivo-var-latin.woff2');
  });

  it('AR defaults to Home’s 800 face; a route may name the weight its heading renders in', () => {
    expect(heroFontPreload('ar')).toBe('/fonts/almarai-800-arabic.woff2');
    expect(heroFontPreload('ar', 'almarai-700')).toBe('/fonts/almarai-700-arabic.woff2');
  });

  it('every preloadable face exists and is inside the hero budget (35 KB Latin / 45 KB Arabic)', () => {
    const size = (href: string) => statSync(`public${href}`).size;
    expect(size(heroFontPreload('en'))).toBeLessThanOrEqual(35 * 1024);
    for (const face of HERO_FACES) {
      expect(size(heroFontPreload('ar', face)), face).toBeLessThanOrEqual(45 * 1024);
    }
  });
});

describe('the Arabic preload follows the theme’s heading weight (Admin v2 E12)', () => {
  it('a Bold theme preloads the 700 face where the route’s heading is 800', () => {
    expect(themedHeroFace('almarai-800', '700')).toBe('almarai-700');
    expect(heroFontPreload('ar', themedHeroFace('almarai-800', '700'))).toBe(
      '/fonts/almarai-700-arabic.woff2',
    );
  });

  it('no theme, or the brand’s weight, keeps the route’s own face; a 700 route stays 700', () => {
    expect(themedHeroFace('almarai-800', undefined)).toBe('almarai-800');
    expect(themedHeroFace('almarai-800', '800')).toBe('almarai-800');
    expect(themedHeroFace('almarai-700', '700')).toBe('almarai-700');
    expect(themedHeroFace('almarai-700', undefined)).toBe('almarai-700');
  });

  it('BaseLayout hands SeoHead the themed face, read from the theme it links', () => {
    const layout = readFileSync('src/layouts/BaseLayout.astro', 'utf8');
    expect(layout).toContain(
      "themedHeroFace(heroFace ?? 'almarai-800', theme?.tokens['--bs-heading-weight'])",
    );
    expect(layout).toMatch(/<SeoHead[\s\S]*?heroFace=\{face\}[\s\S]*?\/>/);
  });
});
