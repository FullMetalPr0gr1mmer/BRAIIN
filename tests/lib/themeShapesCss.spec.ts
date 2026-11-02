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

  it('the buttons follow the button style', () => {
    const buttons = ALL.filter((r) => r.decls.get('border-radius') === BUTTON).map(
      (r) => r.selector,
    );
    expect(buttons).toEqual([
      '.cta',
      '.site-header__cta, .site-nav__cta',
      '.consent-actions button',
      '.fb__apply',
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

  it('the case token only stands where the brand set capitals, beside the weight', () => {
    expect(cased.length).toBe(24);
    for (const r of cased) expect(r.decls.get('font-weight'), r.selector).toBe(WEIGHT);
    expect(DEFAULT_TYPE.headingCase).toBe('uppercase');
  });

  it('no Arabic (RTL) rule reads a shape or type token; their `none` overrides stay', () => {
    const rtl = ALL.filter((r) => r.selector.includes("[dir='rtl']"));
    for (const r of rtl) {
      for (const v of r.decls.values()) {
        for (const name of SHAPE_TOKEN_NAMES) expect(v, r.selector).not.toContain(name);
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
