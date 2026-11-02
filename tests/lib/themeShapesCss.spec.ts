import { readFileSync } from 'node:fs';
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
//   - every component radius is a token or one of the fixed shapes (a circle, a chip's pill,
//     none, inherited), so a card added later follows the theme's corners or is named here;
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

describe('the corners: every component radius is a token or a fixed shape', () => {
  // The fixed shapes: circles, chips' pills, none, inherited from a rounded parent; and the
  // two radii that are not a card, an image or an input (the menu toggle's, a scrollbar's).
  const FIXED = new Set(['50%', '999px', '0', 'inherit']);
  const NAMED: Record<string, string> = {
    '.site-nav__toggle': '0.4rem',
    '.fb__svc::-webkit-scrollbar-thumb': '4px',
  };

  it('no other radius is written', () => {
    const stray = ALL.filter((r) => {
      const v = r.decls.get('border-radius');
      if (v === undefined) return false;
      if (SCALED.test(v) || v === BUTTON || FIXED.has(v)) return false;
      return NAMED[r.selector] !== v;
    }).map((r) => `${r.sheet} ${r.selector}: ${r.decls.get('border-radius')}`);
    expect(stray).toEqual([]);
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
    // panel's `.svc-xp__btn`, so it follows the style too (it stayed a pill under Square once).
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

  it('the headings and display lines set in 800 follow the weight', () => {
    expect(weighted.length).toBe(26);
    expect(DEFAULT_TYPE.headingWeight).toBe(800);
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
    const TEXT: Record<string, { colour: [string, string]; sized: string[] }> = {
      // The hero's highlighted word inherits the h1's size and weight (both directions).
      "the hero's highlighted word and focus rings on black": {
        colour: ['.hero h1 .accent', 'var(--bs-cobalt)'],
        sized: ['.hero h1', "html[dir='rtl'] .hero h1"],
      },
    };
    const low = [...pairs.site.pairs, ...pairs.admin.pairs].filter((p) => p[2] < 4.5);

    /** A declaration's value, a `var(--x)` read from the global sheet's `:root`. */
    function resolve(value: string): string {
      const v = /^var\((--[a-z0-9-]+)\)$/.exec(value);
      if (!v) return value;
      const root = ALL.find((r) => r.selector === ':root' && r.decls.has(v[1]!));
      return root ? resolve(root.decls.get(v[1]!)!) : value;
    }
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
      for (const [what, { colour, sized }] of Object.entries(TEXT)) {
        const painted = ALL.find((r) => r.selector === colour[0]);
        expect(painted?.decls.get('color'), what).toBe(colour[1]);
        // The weight is the first sized rule's (a mirrored rule inherits it).
        const weightDecl = sized
          .map((s) => ALL.find((r) => r.selector === s)?.decls.get('font-weight'))
          .find((w) => w !== undefined);
        const weight = weightDecl === undefined ? 400 : weightOf(weightDecl);
        for (const s of sized) {
          const rule = ALL.find((r) => r.selector === s);
          expect(rule, `${what}: ${s}`).toBeDefined();
          const size = minPx(resolve(rule!.decls.get('font-size') ?? ''));
          expect(size, `${what}: ${s} has a font-size`).not.toBeNull();
          const large = size! >= 24 || (size! >= 18.66 && weight !== null && weight >= 700);
          expect(large, `${what}: ${s} at ${size}px, weight ${weight}`).toBe(true);
        }
      }
    });
  });

  it('the case token only stands where the brand set capitals, beside the weight', () => {
    expect(cased.length).toBe(24);
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
