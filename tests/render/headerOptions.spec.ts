import { beforeEach, describe, expect, test, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import SiteHeader from '@/components/SiteHeader.astro';
import { HEADER_DEFAULTS, type HeaderSettings } from '@schemas/appearance';
import { IDENTITY } from './fixtures';
import { normalise } from './harness';

// The header's options (Admin v2 E5, `public.site_appearance`). siteChrome.spec.ts holds the
// header with no row to the bytes it served before E5 (its snapshot is unchanged); this spec
// holds what a saved row changes: one `data-*` attribute per option that differs from the
// header as built, the logo's `sizes` following its preset, and the call-to-action button in
// the bar and in the small-screen menu, as text, with its link localized.

const state = vi.hoisted(() => ({ settings: null as HeaderSettings | null }));
vi.mock('@/lib/data/appearance', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getHeaderSettings: async () => state.settings,
}));

beforeEach(() => {
  state.settings = { ...HEADER_DEFAULTS };
});

async function render(locale: 'en' | 'ar', variant: 'overlay' | 'solid' = 'overlay') {
  const container = await AstroContainer.create();
  const path = locale === 'ar' ? '/ar/about' : '/about';
  const html = await container.renderToString(SiteHeader, {
    props: { locale, variant },
    request: new Request(`https://www.example.test${path}`),
    locals: { identity: Promise.resolve(IDENTITY) } as App.Locals,
  });
  return normalise(html);
}

/** The opening <header> tag. */
const headerTag = (html: string) => /<header\b[^>]*>/.exec(html)?.[0] ?? '';

describe('the header options', () => {
  test('the defaults add no attribute, no button and no end group', async () => {
    const html = await render('en');
    expect(headerTag(html)).not.toMatch(/data-(logo|align|sticky|hide|solid|tint|blur|mobile)/);
    expect(html).not.toContain('site-header__end');
    expect(html).not.toContain('site-header__cta');
    expect(html).not.toContain('site-nav__cta');
    expect(html).toContain('sizes="clamp(96px, 10vw, 132px)"');
  });

  test('each option that differs is one attribute with its bucket', async () => {
    state.settings = {
      ...HEADER_DEFAULTS,
      logoPosition: 'center',
      logoSize: 'l',
      menuAlign: 'end',
      sticky: false,
      hideOnScroll: false,
      solidAfterHero: false,
      tint: 'medium',
      blur: 'strong',
      mobileMenu: 'full',
    };
    const tag = headerTag(await render('en'));
    expect(tag).toContain('data-logo="l"');
    expect(tag).toContain('data-logo-pos="center"');
    expect(tag).toContain('data-align="end"');
    expect(tag).toContain('data-sticky="off"');
    expect(tag).toContain('data-hide="off"');
    expect(tag).toContain('data-solid="off"');
    expect(tag).toContain('data-tint="medium"');
    expect(tag).toContain('data-blur="strong"');
    expect(tag).toContain('data-mobile="full"');
    // Never an inline style (CSP: style-src has no 'unsafe-inline').
    expect(tag).not.toContain('style=');
  });

  test('the logo sizes follow the preset', async () => {
    state.settings = { ...HEADER_DEFAULTS, logoSize: 's' };
    expect(await render('en')).toContain('sizes="clamp(80px, 8vw, 108px)"');
    state.settings = { ...HEADER_DEFAULTS, logoSize: 'l' };
    expect(await render('en')).toContain('sizes="clamp(96px, 12vw, 160px)"');
  });

  test('the button: in the bar and in the menu, as text, its link localized', async () => {
    state.settings = {
      ...HEADER_DEFAULTS,
      ctaShow: true,
      ctaLabel: { en: 'Start <b>a</b> project', ar: 'ابدأ مشروعك' },
      ctaHref: '/contact#inquiry',
    };
    const en = await render('en');
    expect(en).toContain('<div class="site-header__end">');
    expect(en).toMatch(
      /<a class="site-header__cta" href="\/contact#inquiry"[^>]*>Start &lt;b&gt;a&lt;\/b&gt; project<\/a>/,
    );
    expect(en).toMatch(
      /<li class="site-nav__cta-item"><a class="site-nav__cta" href="\/contact#inquiry"/,
    );
    // The language switch is still there, inside the end group (O-13: always shown).
    expect(en).toMatch(
      /<div class="site-header__end">[\s\S]*class="site-header__lang"[\s\S]*<\/div>/,
    );
    const ar = await render('ar');
    expect(ar).toContain('href="/ar/contact#inquiry"');
    expect(ar).toContain('>ابدأ مشروعك</a>');
  });

  test('an https button link is left as it is', async () => {
    state.settings = {
      ...HEADER_DEFAULTS,
      ctaShow: true,
      ctaLabel: { en: 'Book a call', ar: 'احجز مكالمة' },
      ctaHref: 'https://calendly.example/studio',
    };
    expect(await render('ar')).toContain('href="https://calendly.example/studio"');
  });

  test('the solid variant takes the same attributes', async () => {
    state.settings = { ...HEADER_DEFAULTS, logoSize: 's', hideOnScroll: false };
    const tag = headerTag(await render('en', 'solid'));
    expect(tag).toContain('data-header="solid"');
    expect(tag).toContain('data-logo="s"');
    expect(tag).toContain('data-hide="off"');
  });
});
