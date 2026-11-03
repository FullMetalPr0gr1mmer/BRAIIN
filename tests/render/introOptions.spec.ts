import { describe, expect, test } from 'vitest';
import { INTRO_DEFAULTS, type IntroSettings } from '@schemas/appearance';
import { DEFAULT_HOME_SECTIONS, withHomeData, withHomeIntro } from '@/lib/sections/types';
import { LOCALES, renderSections } from './harness';

// The loading screen's look (Admin v2 E7, site_appearance's intro_ columns), rendered through
// SectionRenderer as the home route composes it (withHomeIntro, then withHomeData with the
// look). sections.spec.ts holds the plate with no look to the bytes it served before E7 (its
// snapshot is unchanged); this spec holds that the intro as built, read from a row at its
// defaults, is those same bytes, and what a saved look changes: one `data-*` bucket per option
// off its default, the tagline as text in the page's language, the bar, and never the logo.

const home = (intro?: IntroSettings) =>
  withHomeData(withHomeIntro(DEFAULT_HOME_SECTIONS.slice(0, 1)), {
    featured: [],
    ctaHref: '/portfolio',
    disciplines: [],
    ...(intro ? { intro } : {}),
  });

/** The plate: from its opening tag to the hero's section. */
const plate = (html: string): string => {
  const start = html.indexOf('<div class="intro"');
  expect(start, 'the plate renders').toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf('<section class="hero', start));
};
const openTag = (html: string): string => /<div class="intro"[^>]*>/.exec(html)?.[0] ?? '';

describe('the intro as built', () => {
  for (const locale of LOCALES) {
    test(`a look at its defaults renders the bytes of no look at all (${locale})`, async () => {
      const without = await renderSections(home(), locale);
      const atDefaults = await renderSections(home({ ...INTRO_DEFAULTS }), locale);
      expect(atDefaults).toBe(without);
      expect(openTag(without)).toBe('<div class="intro" aria-hidden="true">');
      expect(without).not.toContain('intro__');
    });
  }
});

describe('a saved look', () => {
  test('one data-* bucket per timing or backdrop option off its default, and none for the rest', async () => {
    const html = await renderSections(home({ ...INTRO_DEFAULTS, holdMs: 800 }), 'en');
    expect(openTag(html)).toBe('<div class="intro" aria-hidden="true" data-hold="800">');
    const all = await renderSections(
      home({ ...INTRO_DEFAULTS, backdrop: 'black', holdMs: 1500, fadeMs: 300 }),
      'en',
    );
    expect(openTag(all)).toBe(
      '<div class="intro" aria-hidden="true" data-backdrop="black" data-hold="1500" data-fade="300">',
    );
    const light = await renderSections(home({ ...INTRO_DEFAULTS, backdrop: 'light' }), 'ar');
    expect(openTag(light)).toBe('<div class="intro" aria-hidden="true" data-backdrop="light">');
  });

  test('the tagline is text in the page language, escaped, under the logo', async () => {
    const tagline = { en: 'Ideas <b>that</b> work & last', ar: 'أفكار تعمل وتدوم' };
    const en = plate(await renderSections(home({ ...INTRO_DEFAULTS, tagline }), 'en'));
    expect(en).toContain(
      '<div class="intro__below"><p class="intro__tag">Ideas &lt;b&gt;that&lt;/b&gt; work &amp; last</p></div>',
    );
    expect(en).not.toContain('<b>');
    const ar = plate(await renderSections(home({ ...INTRO_DEFAULTS, tagline }), 'ar'));
    expect(ar).toContain('<p class="intro__tag">أفكار تعمل وتدوم</p>');
    // Below the logo, inside the plate (it leaves with it).
    expect(en.indexOf('<picture')).toBeLessThan(en.indexOf('intro__below'));
  });

  test('the bar, with or without a tagline', async () => {
    const bar = plate(await renderSections(home({ ...INTRO_DEFAULTS, bar: true }), 'en'));
    expect(bar).toContain(
      '<div class="intro__below"><span class="intro__bar"><i></i></span></div>',
    );
    const both = plate(
      await renderSections(
        home({ ...INTRO_DEFAULTS, bar: true, tagline: { en: 'Hello', ar: 'مرحبا' } }),
        'en',
      ),
    );
    expect(both).toContain(
      '<div class="intro__below"><p class="intro__tag">Hello</p><span class="intro__bar"><i></i></span></div>',
    );
  });

  test('the logo never changes with the look (the home LCP element, CLAUDE.md §6)', async () => {
    const logo = (html: string) => /<picture>[\s\S]*?<\/picture>/.exec(plate(html))?.[0];
    const built = logo(await renderSections(home(), 'en'));
    expect(built).toBeTruthy();
    for (const look of [
      { ...INTRO_DEFAULTS, backdrop: 'black' as const, bar: true },
      { ...INTRO_DEFAULTS, backdrop: 'light' as const, tagline: { en: 'Hi', ar: 'أهلا' } },
      { ...INTRO_DEFAULTS, holdMs: 500, fadeMs: 600 },
    ]) {
      expect(logo(await renderSections(home(look), 'en'))).toBe(built);
    }
    expect(built).toContain('fetchpriority="high"');
    expect(built).toContain('loading="eager"');
  });

  test('a hero without the plate takes no look, whatever the route hands it', async () => {
    const sections = withHomeData([{ type: 'hero' }], {
      featured: [],
      ctaHref: '/portfolio',
      disciplines: [],
      intro: { ...INTRO_DEFAULTS, backdrop: 'black', bar: true },
    });
    const html = await renderSections(sections, 'en');
    expect(html).not.toContain('class="intro');
    expect(html).not.toContain('data-backdrop');
  });

  test('the look goes to the first hero only (the one withHomeIntro gives the plate)', () => {
    const intro = { ...INTRO_DEFAULTS, bar: true };
    const out = withHomeData([{ type: 'hero' }, { type: 'hero' }], {
      featured: [],
      ctaHref: '/portfolio',
      disciplines: [],
      intro,
    });
    expect(out[0]?.data).toMatchObject({ introLook: intro });
    expect(out[1]?.data?.['introLook']).toBeUndefined();
    // No look handed over: no key at all (the hero's data as before E7).
    const none = withHomeData([{ type: 'hero' }], {
      featured: [],
      ctaHref: '/portfolio',
      disciplines: [],
    });
    expect(none[0]?.data).toEqual({ ctaHref: '/portfolio' });
  });
});
