import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/*
 * Visual regression over the section appearance variants (Admin v2 E9; README "visual
 * regression over page_sections x EN/AR x light/dark"), on the built Worker, in both languages,
 * on the seeded custom page `how-we-work` (supabase/seed-data/57-custom-page.json: a banner hero
 * and a Text block, published locally and in CI):
 *
 *   - nothing chosen: no route the seed serves carries an appearance attribute (every page's
 *     Tier A HTML is what it was; tests/render/sectionAppearance.spec.ts holds it to the byte);
 *   - each background (light grey, black, primary) on the Text block: its ground is the token it
 *     names, its heading, kicker, body copy and a link inside it pass AA against that ground
 *     (measured in the page, the translucent ones composited), axe finds zero WCAG 2.2 A/AA
 *     violations in the block (its colour-contrast rule included), and again with a theme's
 *     colours and the E12 shape and type tokens set (a palette the theme gate takes:
 *     tests/lib/sectionAppearance.spec.ts holds it to packages/theme/gate.ts);
 *   - each spacing moves only the block's padding above and below, the way it names;
 *   - the reveal: none under reduced motion (the section is simply there), the scroll-driven
 *     animation otherwise where the browser runs one, ended by keyboard focus inside.
 *
 * The attributes are set on the block the way the renderer writes them (src/lib/sections/
 * appearance.ts: on the section's own first element), through the DOM, as the theme suite sets
 * its tokens (no stylesheet, no style attribute, no CSP change); the stored path, from the
 * editor to the served HTML, is tests/admin/section-appearance.e2e.ts's. The pictures of each
 * variant are the design capture's (tests/visual/capture.e2e.ts, "section appearance").
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PATHS = ['/how-we-work', '/ar/how-we-work'] as const;
const BLOCK = 'section.blk-text';

/** A theme palette packages/theme/gate.ts takes (violet; the sky tint skySoftFor derives). */
export const THEME_PALETTE = {
  '--bs-klein': '#5B21B6',
  '--bs-cobalt': '#823BE3',
  '--bs-sky': '#7D76EA',
  '--bs-sky-soft': '#CECBF7',
} as const;
/** E12's shape and type tokens, as tests/visual/theme.e2e.ts sets them. */
const THEMED_SHAPES = {
  '--bs-radius-scale': '0',
  '--bs-btn-radius': '0px',
  '--bs-heading-weight': '700',
  '--bs-heading-case': 'none',
};

type Rgba = [number, number, number, number];
const parse = (css: string): Rgba => {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  expect(m, `a colour: ${css}`).not.toBeNull();
  const [r, g, b, a = '1'] = m![1]!.split(/[\s,/]+/).filter(Boolean);
  return [Number(r), Number(g), Number(b), Number(a)];
};
const over = (fg: Rgba, bg: Rgba): Rgba => {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a)).concat(1) as Rgba;
};
const lum = ([r, g, b]: Rgba) => {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const ratio = (fg: Rgba, bg: Rgba) => {
  const [hi, lo] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

async function open(page: Page, path: string, motion: 'reduce' | 'no-preference' = 'reduce') {
  await page.emulateMedia({ reducedMotion: motion });
  const res = await page.goto(path, { waitUntil: 'load' });
  expect(res?.status(), path).toBe(200);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(BLOCK), 'the seeded Text block').toHaveCount(1);
}

/** Sets attributes on the block (and tokens on <html>), adds a link to its body, reads it. */
async function dress(
  page: Page,
  attrs: Record<string, string>,
  tokens: Record<string, string> = {},
) {
  return page.evaluate(
    ({ selector, attrs, tokens }) => {
      const block = document.querySelector<HTMLElement>(selector)!;
      for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
      for (const [k, v] of Object.entries(attrs)) block.setAttribute(k, v);
      const prose = block.querySelector('.blk-prose');
      if (prose && !prose.querySelector('a[data-e9-probe]')) {
        const p = document.createElement('p');
        const a = document.createElement('a');
        a.href = '#';
        a.dataset['e9Probe'] = '';
        a.textContent = document.documentElement.lang === 'ar' ? 'رابط' : 'a link';
        p.append(a);
        prose.append(p);
      }
      const css = (el: Element | null) => (el ? getComputedStyle(el) : null);
      const of = (sel: string) => css(block.querySelector(sel))?.color ?? null;
      const cs = getComputedStyle(block);
      return {
        bg: cs.backgroundColor,
        heading: of('.blk-head'),
        tag: of('.tag'),
        prose: of('.blk-prose'),
        link: of('.blk-prose a[data-e9-probe]'),
        paddingTop: parseFloat(cs.paddingTop),
        paddingBottom: parseFloat(cs.paddingBottom),
        paddingInline: cs.paddingInlineStart,
        animation: cs.animationName,
      };
    },
    { selector: BLOCK, attrs, tokens },
  );
}

const GROUNDS = {
  mist: 'rgb(243, 245, 250)',
  ink: 'rgb(0, 0, 0)',
  klein: 'rgb(0, 36, 188)',
} as const;

test.describe('nothing chosen, nothing written', () => {
  for (const path of [
    '/',
    '/about',
    '/contact',
    '/services',
    '/join',
    '/portfolio',
    '/portfolio/all',
    ...PATHS,
  ]) {
    test(`${path}: no appearance attribute in the served HTML`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain('<html');
      expect(html).not.toMatch(/\sdata-(bg|space|reveal)="/);
    });
  }
});

for (const path of PATHS) {
  test.describe(`section appearance on ${path}`, () => {
    for (const [bg, ground] of Object.entries(GROUNDS)) {
      for (const themed of [false, true]) {
        test(`background ${bg}${themed ? ', under a theme' : ''}: AA in the page, axe clean`, async ({
          page,
        }) => {
          await open(page, path);
          const tokens = themed ? { ...THEME_PALETTE, ...THEMED_SHAPES } : {};
          const read = await dress(page, { 'data-bg': bg }, tokens);
          const groundNow = themed && bg === 'klein' ? 'rgb(91, 33, 182)' : ground;
          expect(read.bg).toBe(groundNow);
          const base = parse(read.bg);
          for (const [what, colour] of Object.entries({
            heading: read.heading,
            tag: read.tag,
            prose: read.prose,
            link: read.link,
          })) {
            expect(colour, `${what} is drawn`).not.toBeNull();
            expect(ratio(parse(colour!), base), `${what} on ${bg}`).toBeGreaterThanOrEqual(4.5);
          }
          const axe = await new AxeBuilder({ page }).include(BLOCK).withTags(WCAG).analyze();
          expect(
            axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
          ).toEqual([]);
        });
      }
    }

    test('each spacing moves only the padding above and below, the way it names', async ({
      page,
    }) => {
      await open(page, path);
      const own = await dress(page, {});
      const compact = await dress(page, { 'data-space': 'compact' });
      const roomy = await dress(page, { 'data-space': 'roomy' });
      expect(compact.paddingTop).toBeLessThan(own.paddingTop);
      expect(compact.paddingBottom).toBeLessThan(own.paddingBottom);
      expect(roomy.paddingTop).toBeGreaterThan(own.paddingTop);
      expect(roomy.paddingBottom).toBeGreaterThan(own.paddingBottom);
      expect(new Set([own.paddingInline, compact.paddingInline, roomy.paddingInline]).size).toBe(1);
      expect(compact.bg).toBe(own.bg);
    });

    test('the reveal: none under reduced motion; the scroll animation otherwise, ended by focus', async ({
      page,
    }) => {
      await open(page, path, 'reduce');
      const still = await dress(page, { 'data-reveal': 'rise' });
      expect(still.animation).toBe('none');

      await open(page, path, 'no-preference');
      const supported = await page.evaluate(() => CSS.supports('animation-timeline: view()'));
      const moving = await dress(page, { 'data-reveal': 'rise' });
      expect(moving.animation).toBe(supported ? 'bs-section-rise' : 'none');
      const fading = await dress(page, { 'data-reveal': 'fade' });
      expect(fading.animation).toBe(supported ? 'bs-section-fade' : 'none');
      // Keyboard focus inside the section ends it (WCAG 2.4.7).
      await page.locator(`${BLOCK} a[data-e9-probe]`).focus();
      const focused = await page.evaluate(
        (sel) => getComputedStyle(document.querySelector(sel)!).animationName,
        BLOCK,
      );
      expect(focused).toBe('none');
    });
  });
}
