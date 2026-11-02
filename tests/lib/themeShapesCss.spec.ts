import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUTTON_RADIUS,
  CORNER_SCALE,
  DEFAULT_SHAPES,
  DEFAULT_TYPE,
  HEADING_WEIGHTS,
  MAX_CORNER_SCALE,
  SHAPE_TOKEN_NAMES,
} from '@theme/shapes';

// The public stylesheets' shape and type tokens (Admin v2 E12, AV-32): what a theme's corners,
// buttons and headings reach, and that an unthemed page computes exactly what it did before.
//
//   - every component radius is a token or one of the fixed shapes (a circle, none, inherited,
//     or a pill named here with its reason, never a button), so a card added later follows the
//     theme's corners and a button the theme's buttons, or is named here;
//   - every heading or display line written in the brand's 800 or in capitals reads the weight
//     and case tokens, or is named here with its reason (E12 code review CR3: the spec holds
//     the rule, not a count);
//   - each token's fallback is the brand's own value (the page with no theme is the page as
//     designed: E12's refactor was checked equal to main's stylesheets once every fallback is
//     substituted, as-built E12);
//   - legibility: a rounded corner never cuts into the text inside the box, at the largest
//     corner a theme can choose; headings stay bold at every weight offered; the case token
//     only replaces an `uppercase` the brand set, and never in an Arabic (RTL) rule.

const SHEETS = [
  'global.css',
  'about.css',
  'work.css',
  'banner.css',
  'case-study.css',
  'services.css',
  'join.css',
] as const;

interface Rule {
  sheet: string;
  selector: string;
  decls: Map<string, string>;
}

/** Every innermost rule of a sheet (media queries included), comments dropped. */
function rules(sheet: string): Rule[] {
  const css = readFileSync(`public/styles/${sheet}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.replace(/\s+/g, ' ').trim();
    if (selector.startsWith('@')) continue;
    const decls = new Map<string, string>();
    for (const d of m[2]!.split(';')) {
      const at = d.indexOf(':');
      if (at < 0) continue;
      decls.set(d.slice(0, at).trim(), d.slice(at + 1).trim());
    }
    out.push({ sheet, selector, decls });
  }
  return out;
}

const ALL = SHEETS.flatMap(rules);
const SCALED = /^calc\(([0-9.]+)(px|rem) \* var\(--bs-radius-scale, 1\)\)$/;
const BUTTON = 'var(--bs-btn-radius, 999px)';
const WEIGHT = 'var(--bs-heading-weight, 800)';
const CASE = 'var(--bs-heading-case, uppercase)';

/** A declaration's value, a `var(--x)` read from the global sheet's `:root`. */
function resolve(value: string): string {
  const v = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (!v) return value;
  const root = ALL.find((r) => r.selector === ':root' && r.decls.has(v[1]!));
  return root ? resolve(root.decls.get(v[1]!)!) : value;
}

/** A length's smallest px: px, rem (16 px), or the minimum of a clamp(). */
function minPx(value: string): number | null {
  const clamp = /^clamp\(\s*([0-9.]+)(px|rem)/.exec(value);
  const one = clamp ?? /^([0-9.]+)(px|rem)$/.exec(value);
  if (one) return Number(one[1]) * (one[2] === 'rem' ? 16 : 1);
  if (value === '0') return 0;
  return null;
}

/** The box's smallest padding on any side (null when it sets none). */
function minPadding(rule: Rule): number | null {
  const parts: string[] = [];
  const padding = rule.decls.get('padding');
  if (padding) parts.push(...padding.split(/\s+(?![^(]*\))/));
  for (const side of ['padding-inline', 'padding-block']) {
    const v = rule.decls.get(side);
    if (v) parts.push(...v.split(/\s+(?![^(]*\))/));
  }
  if (parts.length === 0) return null;
  const px = parts.map(minPx);
  return px.some((p) => p === null) ? null : Math.min(...(px as number[]));
}

/** The subject of each selector in a list: its last compound (`.a .b > .c` is `.c`). */
function subjects(selector: string): string[] {
  return selector.split(',').map((s) =>
    s
      .trim()
      .split(/\s*[\s>+~]\s*/)
      .pop()!,
  );
}

/**
 * Every class a `<button>` carries in the public markup (src/components, src/layouts and
 * src/pages, the admin left out): a rule that names one is a button's.
 */
function buttonClasses(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'admin' ? [] : walk(path);
      return e.name.endsWith('.astro') ? [path] : [];
    });
  for (const file of ['src/components', 'src/layouts', 'src/pages'].flatMap(walk)) {
    const src = readFileSync(file, 'utf8');
    for (const tag of src.matchAll(/<button\b([^>]*)>/g)) {
      const attr = /\bclass(?::list)?=(\{[^}]*\}|"[^"]*")/.exec(tag[1]!);
      if (!attr) continue;
      for (const quoted of attr[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)) {
        for (const name of quoted[1]!.split(/\s+/)) if (name) out.add(name);
      }
    }
  }
  return out;
}

describe('the corners: every component radius is a token or a fixed shape', () => {
  // The fixed shapes: circles, none, inherited from a rounded parent; the pills named below;
  // and the two radii that are not a card, an image or an input (the menu toggle's, a
  // scrollbar's).
  const FIXED = new Set(['50%', '0', 'inherit']);
  const NAMED: Record<string, string> = {
    '.site-nav__toggle': '0.4rem',
    '.fb__svc::-webkit-scrollbar-thumb': '4px',
  };

  // A literal pill is a fixed shape only where it is not an action: chips, tags, filters, a
  // toggle, a field. Each is named with its reason; a button never is (it reads the button
  // style), so a new button at a literal 999px fails here, whatever its class is called.
  const PILLS: Record<string, string> = {
    '.badge': 'a small status label',
    '.site-header__lang': 'the language toggle, a switch beside the header button',
    '.disc-card__n': "a discipline card's number",
    '.search-form input': 'the search field',
    '.ftag': "a project card's facet tag",
    '.fchip': "a filter chip (Our Work's service filter)",
    '.fb__sel select': "the filter bar's select",
    '.fpill': 'an active filter, a removable chip',
    '.cs-kw li': "a case study's keyword",
    '.cs-bdi__tag': "a breakdown item's tag",
    '.svc-tab': "the explorer's discipline tab, a tab strip like the filter chips",
    '.svc-xp__cap': "the explorer's caption over its picture",
    '.svc-case__meta a, .svc-case__meta span': "a case block's meta chips",
    '.af-chip span': 'a craft chip of the application form (a checkbox)',
  };

  it('no other radius is written', () => {
    const stray = ALL.filter((r) => {
      const v = r.decls.get('border-radius');
      if (v === undefined) return false;
      if (SCALED.test(v) || v === BUTTON || FIXED.has(v)) return false;
      if (v === '999px' && r.selector in PILLS) return false;
      return NAMED[r.selector] !== v;
    }).map((r) => `${r.sheet} ${r.selector}: ${r.decls.get('border-radius')}`);
    expect(stray).toEqual([]);
  });

  it('a literal pill is a named fixed shape, never a button', () => {
    const pills = ALL.filter((r) => r.decls.get('border-radius') === '999px').map(
      (r) => r.selector,
    );
    // Every name still stands (no stale reason), and nothing else is a literal pill.
    expect(new Set(pills)).toEqual(new Set(Object.keys(PILLS)));
    // A button by its name: `button`, `.cta…` or `…btn…`.
    const named = Object.keys(PILLS).filter((s) => /(^|[\s,>+~])button\b|\.cta|btn/i.test(s));
    expect(named).toEqual([]);
    // A button by its markup: a class some public `<button>` carries.
    const classes = buttonClasses();
    expect(classes.has('af-drop__x'), 'the markup scan finds the buttons').toBe(true);
    const onButtons = Object.keys(PILLS).filter((s) =>
      subjects(s).some((subject) =>
        [...subject.matchAll(/\.([a-z0-9_-]+)/gi)].some((m) => classes.has(m[1]!)),
      ),
    );
    expect(onButtons).toEqual([]);
  });

  it('the scale reaches the cards, images, panels and inputs of every sheet', () => {
    const scaled = ALL.filter((r) => SCALED.test(r.decls.get('border-radius') ?? ''));
    expect(scaled.length).toBe(34);
    expect(new Set(scaled.map((r) => r.sheet))).toEqual(new Set(SHEETS));
  });

  it('a clip that rounds a card follows the corners too, never a fixed radius', () => {
    // The discipline card on a wide screen draws its corners with clip-path's `round` (its
    // border-radius is 0 there); a fixed `round 18px` stayed rounded under Square corners.
    const clips = ALL.filter((r) => / round /.test(r.decls.get('clip-path') ?? ''));
    expect(clips.map((r) => `${r.sheet} ${r.selector}`)).toEqual([
      'global.css .disc__stage:not(:has(> :nth-child(7))) .disc-card__clip',
      "global.css html[dir='rtl'] .disc__stage:not(:has(> :nth-child(7))) .disc-card__clip",
    ]);
    for (const r of clips) {
      expect(r.decls.get('clip-path')!.replace(/\s+/g, ' '), r.selector).toMatch(
        / round calc\(18px \* var\(--bs-radius-scale, 1\)\) ?\)$/,
      );
    }
  });

  it('the buttons follow the button style', () => {
    // The explorer's per-row Inquire link (`.svc-row__q`) is an outlined button beside the
    // panel's `.svc-xp__btn`, so it follows the style too (it stayed a pill under Square once),
    // and so does the CV drop zone's Remove button (`.af-drop__x`, E12 code review CR1).
    const buttons = ALL.filter((r) => r.decls.get('border-radius') === BUTTON).map(
      (r) => r.selector,
    );
    expect(buttons).toEqual([
      '.cta',
      '.site-header__cta, .site-nav__cta',
      '.consent-actions button',
      '.fb__apply',
      '.svc-row__q',
      '.svc-xp__btn',
      '.svc-case__see',
      '.svc-fab',
      '.af-drop__x',
    ]);
  });

  it("each fallback is the brand's: a scale of 1 and a pill", () => {
    expect(CORNER_SCALE[DEFAULT_SHAPES.corners]).toBe(1);
    expect(BUTTON).toBe(`var(--bs-btn-radius, ${BUTTON_RADIUS[DEFAULT_SHAPES.buttons]}px)`);
    const all = SHEETS.map((s) => readFileSync(`public/styles/${s}`, 'utf8')).join('\n');
    // Every use of a token, with its fallback: none is written another way.
    for (const name of SHAPE_TOKEN_NAMES) {
      const uses = [...all.matchAll(new RegExp(`var\\(${name}(, [^)]*)?\\)`, 'g'))].map(
        (m) => m[0],
      );
      expect(uses.length, name).toBeGreaterThan(0);
      expect(new Set(uses), name).toEqual(
        new Set([
          {
            '--bs-radius-scale': 'var(--bs-radius-scale, 1)',
            '--bs-btn-radius': BUTTON,
            '--bs-heading-weight': WEIGHT,
            '--bs-heading-case': CASE,
          }[name],
        ]),
      );
    }
  });

  it('legibility: at the roundest corner, the curve stays outside the padding', () => {
    // A corner of radius r cuts into the box by r(1 - 1/√2) along its diagonal: text set at the
    // padding's inset is clear of the curve while the padding is at least that.
    const cut = 1 - 1 / Math.SQRT2;
    const tight: string[] = [];
    for (const r of ALL) {
      const m = SCALED.exec(r.decls.get('border-radius') ?? '');
      if (!m) continue;
      const radius = Number(m[1]) * (m[2] === 'rem' ? 16 : 1) * MAX_CORNER_SCALE;
      const pad = minPadding(r);
      if (pad !== null && pad < radius * cut) {
        tight.push(`${r.sheet} ${r.selector}: padding ${pad}px under ${radius * cut}px`);
      }
    }
    expect(tight).toEqual([]);
  });

  it('legibility: a scaled box with no padding of its own holds no text at its edge', () => {
    // Frames of a picture or a video, focus rings, an icon tile, and two boxes whose text sits
    // well inside (the explorer's panel, whose grid pads it; the discipline card, whose pill
    // and title are inset 26 px and more, past the roundest corner's 7.9 px cut). A new box
    // here is a decision: give it a padding the corner clears, or name it.
    const bare = ALL.filter(
      (r) => SCALED.test(r.decls.get('border-radius') ?? '') && minPadding(r) === null,
    ).map((r) => r.selector);
    expect(bare).toEqual([
      '.disc-card__clip',
      '.disc-card__ring',
      '.stream',
      '.mf',
      '.mf--film',
      '.leader__ph',
      '.cs-bdi__open',
      '.lightbox__img',
      '.svc-panel',
      '.svc-xp__media',
      '.svc-case__img',
      '.af-drop__input:focus-visible + .af-drop__ico::before',
      '.af-drop__ico',
    ]);
  });
});

describe('the headings: weight and case', () => {
  const weighted = ALL.filter((r) => r.decls.get('font-weight') === WEIGHT);
  const cased = ALL.filter((r) => r.decls.get('text-transform') === CASE);

  // A heading or display line: a rule whose subject is an h1 to h6, or that is set in the
  // brand's 800 (literal or token), or whose smallest size is display size (24 px or more).
  // One of them written in a literal 800 or in literal capitals keeps that look under every
  // theme, so it is named here with its reason: numbers, initials and bold words inside body
  // copy are not headings. Labels (under 24 px, 700 or lighter) may be capitals freely.
  const STAY: Record<string, string> = {
    '.about-intro h2 b': 'the bold words inside a 500 weight lead, emphasis in running text',
    '.stat-value': 'a stat counter, a number',
    '.sb__n': "the stat band's number",
    '.tm__av': "a testimonial's initials in a circle",
    '.sel-work__blurb b': "the featured project's bold words inside its blurb",
    '.cs-res__v': "a case study's result, a number",
    '.cs-quote__av': "a case study quote's initials in a circle",
    '.svc-proof__rate b': "the proof band's rating, a number",
    '.svc-proof__n': "the proof band's number",
    '.svc-prob__n': "a problem's number",
    '.svc-res__n': "a result's number",
    '.join-step__n': "a Join step's number in a circle",
  };
  const isDisplay = (r: Rule) => {
    const w = r.decls.get('font-weight');
    const size = minPx(resolve(r.decls.get('font-size') ?? ''));
    return (
      subjects(r.selector).some((subject) => /^h[1-6]\b/.test(subject)) ||
      w === '800' ||
      w === '900' ||
      w === WEIGHT ||
      (size !== null && size >= 24)
    );
  };

  it('every heading and display line in 800 or capitals reads the tokens, or is named', () => {
    expect(weighted.length, 'the weight token is read').toBeGreaterThan(0);
    expect(DEFAULT_TYPE.headingWeight).toBe(800);
    const literal = ALL.filter(
      (r) =>
        isDisplay(r) &&
        (['800', '900'].includes(r.decls.get('font-weight') ?? '') ||
          r.decls.get('text-transform') === 'uppercase'),
    ).map((r) => r.selector);
    // Every name still stands (no stale reason), and no other display rule is literal.
    expect(new Set(literal)).toEqual(new Set(Object.keys(STAY)));
    // None of them is in capitals: a capitalised display line always follows the case token.
    const capitals = ALL.filter(
      (r) => r.selector in STAY && r.decls.get('text-transform') === 'uppercase',
    ).map((r) => r.selector);
    expect(capitals).toEqual([]);
  });

  it('legibility: every weight offered is bold (WCAG large text needs 700 or more)', () => {
    for (const w of HEADING_WEIGHTS) expect(w).toBeGreaterThanOrEqual(700);
  });

  describe('legibility: every 3:1 text pair is large text at every weight a theme offers', () => {
    // WCAG 1.4.3 lets text pass at 3:1 only when it is large: 24 px at any weight, or 18.66 px
    // (14 pt) at 700 or more. The contrast gate scores some pairs at 3:1, so the text those
    // pairs colour must stay large under every heading weight a theme can choose (the weight
    // token's lightest offer, not the brand's 800). Every pair under 4.5:1 is named here as
    // text (with the rule that colours it and the rules that size it) or as not text (icons,
    // rings, discs, marks), so a new 3:1 pair is a decision, never a silent pass.
    type Pair = [string, string, number, string];
    const pairs = JSON.parse(readFileSync('packages/theme/pairs.json', 'utf8')) as Record<
      'site' | 'admin',
      { pairs: Pair[] }
    >;
    const NOT_TEXT = new Set([
      'the check on a Primary disc',
      'an arrow on a Primary disc',
      'arrows, underlines and focus rings on white',
      'the plus on a value card',
      'focus rings on white',
      'focus rings on the light section',
      'the Say hello icons',
      'switches, checkboxes and radios',
      "a list row's icon",
      "a switch's knob when on",
      'the first chart series on a card',
      'the first chart series on the background',
    ]);
    interface TextPair {
      /** The rule that paints the text in the pair's colour, and that colour. */
      colour: [string, string];
      /** The selectors of the element the text inherits from (its rules found, not listed). */
      element: RegExp;
      /** The element's rules that size it: every variant and direction (presence, then shape). */
      sized: string[];
      /** The classes between that element and the glyphs: none may size or weigh them. */
      inherits: string[];
    }
    const TEXT: Record<string, TextPair> = {
      // The hero's highlighted word inherits the h1's size and weight, in both directions and
      // every hero variant (the banner and the service page's smaller heading), through the
      // word and letter spans (E12 code review CR4).
      "the hero's highlighted word and focus rings on black": {
        colour: ['.hero h1 .accent', 'var(--bs-cobalt)'],
        element: /^(html\[dir='rtl'\] )?\.hero(--[a-z]+)? h1$/,
        sized: [
          '.hero h1',
          "html[dir='rtl'] .hero h1",
          '.hero--banner h1',
          "html[dir='rtl'] .hero--banner h1",
          '.hero--one h1',
          "html[dir='rtl'] .hero--one h1",
        ],
        inherits: ['word', 'letter', 'accent'],
      },
    };
    const low = [...pairs.site.pairs, ...pairs.admin.pairs].filter((p) => p[2] < 4.5);

    const lightest = Math.min(...HEADING_WEIGHTS);
    /** The weight a rule renders at its lightest under any theme. */
    function weightOf(value: string): number | null {
      if (value === WEIGHT) return lightest;
      return /^[0-9]+$/.test(value) ? Number(value) : null;
    }

    it('every pair under 4.5:1 is named, as text or not', () => {
      const whats = low.map((p) => p[3]);
      expect(whats.filter((w) => !NOT_TEXT.has(w) && !(w in TEXT))).toEqual([]);
      // No stale names either.
      expect([...NOT_TEXT, ...Object.keys(TEXT)].filter((w) => !whats.includes(w))).toEqual([]);
    });

    it('the text each 3:1 pair colours is 24 px, or 18.66 px and bold, at its smallest', () => {
      for (const [what, { colour, element, sized, inherits }] of Object.entries(TEXT)) {
        const painted = ALL.find((r) => r.selector === colour[0]);
        expect(painted?.decls.get('color'), what).toBe(colour[1]);
        const rules = ALL.filter((r) => element.test(r.selector));
        const sizing = rules.filter((r) => r.decls.has('font-size'));
        expect(
          sizing.map((r) => r.selector),
          `${what}: every rule that sizes it`,
        ).toEqual(sized);
        // The weight: the lightest any rule of the element sets (none set: 400).
        const weights = rules
          .filter((r) => r.decls.has('font-weight'))
          .map((r) => weightOf(r.decls.get('font-weight')!));
        const known = weights.filter((w): w is number => w !== null);
        const weight =
          weights.length === 0 ? 400 : known.length < weights.length ? null : Math.min(...known);
        for (const rule of sizing) {
          const size = minPx(resolve(rule.decls.get('font-size')!));
          expect(size, `${what}: ${rule.selector} has a font-size`).not.toBeNull();
          const large = size! >= 24 || (size! >= 18.66 && weight !== null && weight >= 700);
          expect(large, `${what}: ${rule.selector} at ${size}px, weight ${weight}`).toBe(true);
        }
        // Nothing between the element and the glyphs sets a size or a weight of its own.
        const own = ALL.filter((r) =>
          subjects(r.selector).some((subject) =>
            inherits.some((c) => new RegExp(`\\.${c}(?![a-z0-9_-])`).test(subject)),
          ),
        )
          .filter((r) => ['font-size', 'font-weight', 'font'].some((p) => r.decls.has(p)))
          .map((r) => `${r.sheet} ${r.selector}`);
        expect(own, `${what}: the text inherits its size and weight`).toEqual([]);
      }
    });
  });

  it('the case token only stands where the brand set capitals, beside the weight', () => {
    expect(cased.length, 'the case token is read').toBeGreaterThan(0);
    for (const r of cased) expect(r.decls.get('font-weight'), r.selector).toBe(WEIGHT);
    expect(DEFAULT_TYPE.headingCase).toBe('uppercase');
  });

  it('no Arabic (RTL) rule reads a shape or type token; their `none` overrides stay', () => {
    // One exception: the mirrored clip of the discipline card (a corner, not a type token),
    // which must follow the corners exactly as its left-to-right twin does.
    const rtl = ALL.filter((r) => r.selector.includes("[dir='rtl']"));
    for (const r of rtl) {
      for (const [prop, v] of r.decls) {
        for (const name of SHAPE_TOKEN_NAMES) {
          if (prop === 'clip-path' && name === '--bs-radius-scale') continue;
          expect(v, r.selector).not.toContain(name);
        }
      }
    }
    // Each capitalised heading with an Arabic twin keeps it at `none`.
    const twins = cased.filter((r) =>
      rtl.some((t) => t.selector === `html[dir='rtl'] ${r.selector}`),
    );
    expect(twins.length).toBeGreaterThan(15);
    for (const r of twins) {
      const twin = rtl.find((t) => t.selector === `html[dir='rtl'] ${r.selector}`)!;
      if (twin.decls.has('text-transform')) {
        expect(twin.decls.get('text-transform'), twin.selector).toBe('none');
      }
    }
  });
});
