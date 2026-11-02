import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/*
 * Visual regression over the themed output (Admin v2 E12, AV-32; verification.md "Theme v2 and
 * motion": a token refactor with visual regression). The shapes and type a theme sets are four
 * custom properties the public stylesheets read (packages/theme/shapes.ts); this suite proves,
 * on the built Worker in both languages, that:
 *
 *   - the brand's own values change NOTHING: every element's computed corners, weight and case
 *     are the same with the four tokens set to the brand's values as with none (the stylesheets'
 *     fallbacks are the brand's, so a site with no theme renders exactly as before the refactor);
 *   - each choice moves only what it names, and only the way it names: soft corners halve every
 *     radius the scale reaches (each component keeps its proportion), square buttons square the
 *     buttons, Bold turns 800 into 700 and nothing else, "as written" turns capitals into none;
 *   - named probes on Home follow (the hero heading, a discipline card, the consent buttons),
 *     and Arabic keeps its `none` case overrides;
 *   - a themed page (square, Bold, as written) has zero axe violations and no sideways scroll,
 *     at a desktop and a phone width.
 *
 * The tokens are set the way the editor previews them, through the CSSOM on <html> (no
 * stylesheet, no style attribute, no CSP change), and every reading of one pass is taken in
 * ONE synchronous evaluate, so no script can change the page between the readings it compares.
 * The saved theme's own stylesheet is covered end to end by tests/admin/theme.e2e.ts, and the
 * pictures by the design capture (tests/visual/capture.e2e.ts, themed twins).
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const ROUTES = [
  '/',
  '/services',
  '/services/logo',
  '/portfolio',
  '/portfolio/the-rider',
  '/about',
  '/contact',
  '/join',
] as const;

const arOf = (route: string) => (route === '/' ? '/ar' : `/ar${route}`);

type Tokens = Record<string, string>;

/** The brand's own values: exactly the stylesheets' fallbacks. */
const BRAND: Tokens = {
  '--bs-radius-scale': '1',
  '--bs-btn-radius': '999px',
  '--bs-heading-weight': '800',
  '--bs-heading-case': 'uppercase',
};
const PASSES = {
  brand: BRAND,
  soft: { '--bs-radius-scale': '0.5' },
  square: { '--bs-radius-scale': '0' },
  buttons: { '--bs-btn-radius': '0px' },
  bold: { '--bs-heading-weight': '700' },
  written: { '--bs-heading-case': 'none' },
} satisfies Record<string, Tokens>;
/** The themed set the axe and overflow checks read (square, square buttons, Bold, as written). */
const THEMED: Tokens = {
  '--bs-radius-scale': '0',
  '--bs-btn-radius': '0px',
  '--bs-heading-weight': '700',
  '--bs-heading-case': 'none',
};

type Prop = 'radius' | 'clip' | 'weight' | 'case';
interface Change {
  el: string;
  prop: Prop;
  from: string;
  to: string;
}

/**
 * For each pass, every computed change from the untouched page: an element's four corners
 * (as one string), its clip-path (the discipline card rounds its corners with `round` on a
 * wide screen), its weight or its case. Pseudo-elements are not read.
 */
async function changes(page: Page): Promise<Record<keyof typeof PASSES, Change[]>> {
  return page.evaluate((passes) => {
    const root = document.documentElement;
    const names = [...new Set(Object.values(passes).flatMap((p) => Object.keys(p)))];
    const els = [...document.querySelectorAll('body *')];
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList]
        .slice(0, 3)
        .map((c) => `.${c}`)
        .join('')}`;
    const read = () =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        return {
          radius: [
            cs.borderTopLeftRadius,
            cs.borderTopRightRadius,
            cs.borderBottomRightRadius,
            cs.borderBottomLeftRadius,
          ].join(' '),
          clip: cs.clipPath,
          weight: cs.fontWeight,
          case: cs.textTransform,
        };
      });
    const clear = () => names.forEach((n) => root.style.removeProperty(n));
    clear();
    const base = read();
    const out: Record<string, { el: string; prop: string; from: string; to: string }[]> = {};
    for (const [pass, tokens] of Object.entries(passes)) {
      clear();
      for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
      const now = read();
      out[pass] = [];
      now.forEach((n, i) => {
        for (const prop of ['radius', 'clip', 'weight', 'case'] as const) {
          if (n[prop] !== base[i]![prop]) {
            out[pass]!.push({ el: name(els[i]!), prop, from: base[i]![prop], to: n[prop] });
          }
        }
      });
    }
    clear();
    return out;
  }, PASSES) as Promise<Record<keyof typeof PASSES, Change[]>>;
}

const px = (corners: string) => corners.split(' ').map((c) => parseFloat(c));
/** A clip's `round` radii in px (none written: 0), and the clip without them. */
const clipRound = (clip: string) => {
  const m = / round ([^)]*)\)$/.exec(clip);
  return {
    radii: m ? m[1]!.split(' ').map((c) => parseFloat(c)) : [0],
    shape: m ? clip.slice(0, m.index) : clip.replace(/\)$/, ''),
  };
};
/** The radii a corner change reads: a border-radius's four, or a clip's `round`. */
const radiiOf = (c: Change, side: 'from' | 'to') =>
  c.prop === 'clip' ? clipRound(c[side]).radii : px(c[side]);

/** A probe's computed corners, weight and case with the given tokens (none: the brand's). */
async function probe(page: Page, selector: string, tokens: Tokens = {}) {
  return page.evaluate(
    ({ selector, tokens }) => {
      const root = document.documentElement;
      const el = document.querySelector(selector);
      if (!el) return null;
      for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
      const cs = getComputedStyle(el);
      const out = {
        radius: cs.borderTopLeftRadius,
        weight: cs.fontWeight,
        case: cs.textTransform,
      };
      for (const k of Object.keys(tokens)) root.style.removeProperty(k);
      return out;
    },
    { selector, tokens },
  );
}

async function open(page: Page, path: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const res = await page.goto(path, { waitUntil: 'networkidle' });
  expect(res?.status(), path).toBe(200);
  await page.evaluate(() => document.fonts.ready);
}

for (const route of ROUTES) {
  for (const path of [route, arOf(route)]) {
    const arabic = path.startsWith('/ar');

    test(`theme tokens on ${path}: the brand's values change nothing, each choice only its own`, async ({
      page,
    }) => {
      await open(page, path);
      const found = await changes(page);
      const list = (cs: Change[]) => cs.map((c) => `${c.el} ${c.prop} ${c.from} -> ${c.to}`);

      // The brand's values ARE the fallbacks: nothing moves.
      expect(list(found.brand)).toEqual([]);

      // Soft corners: only corners (a radius, or a clip's `round`), each exactly half of its
      // own (the proportion kept); a clip keeps its shape.
      expect(found.soft.length, 'the scale reaches something on every page').toBeGreaterThan(0);
      for (const c of found.soft) {
        expect(['radius', 'clip'], list([c])[0]).toContain(c.prop);
        const [from, to] = [radiiOf(c, 'from'), radiiOf(c, 'to')];
        expect(to.length, list([c])[0]).toBe(from.length);
        to.forEach((v, i) => expect(v, list([c])[0]).toBeCloseTo(from[i]! / 2, 1));
        if (c.prop === 'clip') {
          expect(clipRound(c.to).shape, list([c])[0]).toBe(clipRound(c.from).shape);
        }
      }
      // Square corners: the same elements, every corner 0.
      expect(found.square.map((c) => `${c.el} ${c.prop}`)).toEqual(
        found.soft.map((c) => `${c.el} ${c.prop}`),
      );
      for (const c of found.square) {
        expect(
          radiiOf(c, 'to').every((v) => v === 0),
          list([c])[0],
        ).toBe(true);
      }

      // Square buttons: only radii, to 0 (the consent buttons are on every page).
      expect(found.buttons.length).toBeGreaterThan(0);
      for (const c of found.buttons) {
        expect(c.prop, list([c])[0]).toBe('radius');
        expect(c.to, list([c])[0]).toBe('0px 0px 0px 0px');
      }

      // Bold: only weights, and only 800 to 700 (every weight offered is bold).
      expect(found.bold.length, 'every page has a heading set in the brand weight').toBeGreaterThan(
        0,
      );
      for (const c of found.bold) {
        expect([c.prop, c.from, c.to], list([c])[0]).toEqual(['weight', '800', '700']);
      }

      // As written: only case, and only capitals to none.
      for (const c of found.written) {
        expect([c.prop, c.from, c.to], list([c])[0]).toEqual(['case', 'uppercase', 'none']);
      }
      if (!arabic) expect(found.written.length).toBeGreaterThan(0);
    });
  }
}

for (const path of ['/', '/ar']) {
  test(`named probes on ${path} follow the theme`, async ({ page }) => {
    // A phone width: the discipline card rounds by its border-radius there (a wide screen
    // with hover clips it instead, which the suite above reads).
    await page.setViewportSize({ width: 412, height: 915 });
    await open(page, path);
    const heading = await probe(page, '.hero h1');
    expect(heading, 'the hero heading').toEqual({
      radius: '0px',
      weight: '800',
      case: 'uppercase',
    });
    expect(await probe(page, '.hero h1', THEMED)).toMatchObject({ weight: '700', case: 'none' });

    const button = await probe(page, '.consent-actions button');
    expect(button?.radius, 'a consent button is a pill').toBe('999px');
    expect(
      (await probe(page, '.consent-actions button', { '--bs-btn-radius': '10px' }))?.radius,
    ).toBe('10px');

    const card = await probe(page, '.disc-card__clip');
    expect(card?.radius, 'a discipline card').toBe('18px');
    expect((await probe(page, '.disc-card__clip', { '--bs-radius-scale': '1.5' }))?.radius).toBe(
      '27px',
    );

    // A discipline card's title: capitals in English, none in Arabic, whatever the theme says.
    const title = await probe(page, '.disc-card__t');
    const titled = await probe(page, '.disc-card__t', THEMED);
    if (path === '/ar') {
      expect([title?.case, titled?.case]).toEqual(['none', 'none']);
    } else {
      expect([title?.case, titled?.case]).toEqual(['uppercase', 'none']);
    }
    expect([title?.weight, titled?.weight]).toEqual(['800', '700']);
  });
}

for (const vp of [
  { tag: 'desktop', width: 1366, height: 900 },
  { tag: 'phone', width: 412, height: 915 },
] as const) {
  for (const route of ['/', '/services/logo', '/contact', '/join'] as const) {
    for (const path of [route, arOf(route)]) {
      test(`themed ${path} at ${vp.tag} width: zero axe violations, no sideways scroll`, async ({
        page,
      }) => {
        test.slow();
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await open(page, path);
        await page.evaluate((tokens) => {
          for (const [k, v] of Object.entries(tokens)) {
            document.documentElement.style.setProperty(k, v);
          }
        }, THEMED);
        // Applied: the hero or the page's first heading of the brand weight is now Bold.
        expect(
          await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--bs-heading-weight'),
          ),
        ).toBe('700');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          'no sideways scroll',
        ).toBeLessThanOrEqual(0);
        const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
        expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual(
          [],
        );
      });
    }
  }
}
