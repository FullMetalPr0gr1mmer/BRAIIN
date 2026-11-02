import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { channels, mix } from '@theme/colour';
import { compileTheme, DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { paletteOf } from '@theme/gate';
import { DEFAULT_COLORS, DEFAULT_SKY_SOFT } from '@theme/palette';
import pairs from '@theme/pairs.json';
import { THEME_TOKEN_NAMES } from '@schemas/themeTokens';

// The theme gate's pairs (packages/theme/pairs.json, Admin v2 E4) against the CI contrast audit
// (scripts/contrast-audit.mjs) and the stylesheets the theme overrides. The gate refuses a theme
// pair by pair, so a pair the audit scores but the gate does not know would let a theme break
// AA unseen: every audit pair a theme colour takes part in is a gate pair, and every gate pair
// is an audit pair; each fixed colour is the audit's, and each composite at the brand colours
// is the audit's precomposited value. And the brand colours the gate starts from are the ones
// global.css and admin.css draw with no theme.

const AUDIT = readFileSync('scripts/contrast-audit.mjs', 'utf8');
const GLOBAL_CSS = readFileSync('public/styles/global.css', 'utf8');
const ADMIN_CSS = readFileSync('public/styles/admin.css', 'utf8');

/** A literal of the audit (an object or an array), evaluated: the script runs as a program. */
function literal<T>(start: string, close: string): T {
  const at = AUDIT.indexOf(start);
  expect(at, `contrast-audit.mjs has ${start}`).toBeGreaterThan(-1);
  const end = AUDIT.indexOf(close, at);
  return new Function(
    `return ${AUDIT.slice(at + start.length - 1, end + close.length - 1)}`,
  )() as T;
}

/** The audit's own reader of admin.css :root, lifted out and run on the stylesheet. */
function adminTokens(): Record<string, string> {
  const at = AUDIT.indexOf('function adminTokens(');
  const end = AUDIT.indexOf('\n}\n', at);
  const source = AUDIT.slice(at, end + 2).replace('css = ADMIN_CSS', 'css');
  return new Function(`${source}\nreturn adminTokens;`)()(ADMIN_CSS) as Record<string, string>;
}

type Pair = [string, string, number, string];
type Def = string | [string, number, string];
interface Block {
  colors: Record<string, Def>;
  pairs: Pair[];
}

const T = literal<Record<string, string>>('const T = {', '\n};');
const PAIRS = literal<Pair[]>('const PAIRS = [', '\n];');
const ADMIN_PAIRS = literal<Pair[]>('const ADMIN_PAIRS = [', '\n];');
const A = adminTokens();
const SITE = pairs.site as unknown as Block;
const ADMIN = pairs.admin as unknown as Block;

/** A block's colour at the brand colours. */
function at(block: Block, name: string): string {
  const def = block.colors[name]!;
  if (Array.isArray(def)) return mix(at(block, def[0]), def[1], at(block, def[2]));
  if (def.startsWith('#')) return def.toLowerCase();
  const roles: Record<string, string> = { ...DEFAULT_COLORS, skySoft: DEFAULT_SKY_SOFT };
  return roles[def]!.toLowerCase();
}

/** The colours of a block that move with the theme: a role, or made from one. */
function themed(block: Block): Set<string> {
  const moves = (name: string): boolean => {
    const def = block.colors[name];
    if (def === undefined) return false;
    if (Array.isArray(def)) return moves(def[0]) || moves(def[2]);
    return !def.startsWith('#');
  };
  return new Set(Object.keys(block.colors).filter(moves));
}

const key = ([fg, bg, min]: Pair) => `${fg} on ${bg} at ${min.toFixed(1)}`;

/** Within one step per channel: the audit rounded some composites by hand. */
function near(a: string, b: string): boolean {
  const x = channels(a)!;
  const y = channels(b)!;
  return x.every((c, i) => Math.abs(c - y[i]!) <= 1);
}

describe('the gate knows every audit pair a theme colour is in, and no other', () => {
  it.each([
    ['site', SITE, PAIRS],
    ['admin', ADMIN, ADMIN_PAIRS],
  ] as const)('%s', (_name, block, audit) => {
    const moving = themed(block);
    expect(moving.size).toBeGreaterThan(0);
    const gate = new Set(block.pairs.map(key));
    const wanted = new Set(audit.filter(([fg, bg]) => moving.has(fg) || moving.has(bg)).map(key));
    expect(
      [...wanted].filter((k) => !gate.has(k)),
      'audit pairs the gate lacks',
    ).toEqual([]);
    const scored = new Set(audit.map(key));
    expect(
      [...gate].filter((k) => !scored.has(k)),
      'gate pairs the audit lacks',
    ).toEqual([]);
    // And every gate pair has a theme colour in it: a fixed pair is the audit's alone.
    for (const [fg, bg] of block.pairs)
      expect(moving.has(fg) || moving.has(bg), fg + bg).toBe(true);
  });
});

describe('the colours are the audit’s', () => {
  it('site: every colour at the brand colours is the audit’s T value (composites to a step)', () => {
    for (const name of Object.keys(SITE.colors)) {
      expect(T[name], `contrast-audit.mjs T.${name}`).toBeDefined();
      const ours = at(SITE, name);
      if (Array.isArray(SITE.colors[name])) expect(near(ours, T[name]!), name).toBe(true);
      else expect(ours, name).toBe(T[name]!.toLowerCase());
    }
  });

  it('admin: every colour at the brand colours is admin.css’s (composites to a step)', () => {
    for (const name of Object.keys(ADMIN.colors)) {
      expect(A[name], `admin.css --ad-${name}`).toBeDefined();
      expect(near(at(ADMIN, name), A[name]!), name).toBe(true);
    }
  });

  it('names a colour once per block, and only colours a pair uses', () => {
    for (const block of [SITE, ADMIN]) {
      const used = new Set<string>();
      const walk = (name: string) => {
        used.add(name);
        const def = block.colors[name];
        if (Array.isArray(def)) {
          walk(def[0]);
          walk(def[2]);
        }
      };
      for (const [fg, bg] of block.pairs) [fg, bg].forEach(walk);
      expect([...used].sort()).toEqual(Object.keys(block.colors).sort());
      expect(Object.keys(pairs.site.words).sort()).toEqual(Object.keys(pairs.site.colors).sort());
      expect(Object.keys(pairs.admin.words).sort()).toEqual(Object.keys(pairs.admin.colors).sort());
    }
  });
});

describe('the brand colours are what the stylesheets draw with no theme', () => {
  const root = (css: string) => /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
  const declared = (name: string) =>
    new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(root(GLOBAL_CSS))?.[1]?.trim();

  it('global.css :root holds the defaults, and the tokens a theme compiles to', () => {
    expect(declared('--bs-klein')).toBe(DEFAULT_COLORS.primary.toLowerCase());
    expect(declared('--bs-cobalt')).toBe(DEFAULT_COLORS.hover.toLowerCase());
    expect(declared('--bs-sky')).toBe(DEFAULT_COLORS.accent.toLowerCase());
    expect(declared('--bs-sky-soft')).toBe(DEFAULT_SKY_SOFT.toLowerCase());
    expect(declared('--bs-accent')).toBe('var(--bs-sky)');
  });

  it('the glows and shadows a theme writes are global.css’s own, recoloured', () => {
    // One step off the brand's primary (the brand's own colours write no token at all), then
    // read back at the brand's: alpha, offsets and blur are global.css's.
    const colours = {
      primary: '#0024BD',
      hover: DEFAULT_COLORS.hover,
      accent: DEFAULT_COLORS.accent,
    };
    const tokens = compileTheme({ ...DEFAULT_THEME_SETTINGS, colors: colours });
    const brand = (t: string | undefined) => t?.replace('rgba(0, 36, 189,', 'rgba(0, 36, 188,');
    for (const name of [
      '--bs-glow-klein',
      '--bs-glow-sky',
      '--bs-shadow-klein',
      '--bs-shadow-cobalt',
    ] as const) {
      expect(brand(tokens[name]), name).toBe(declared(name));
    }
  });

  it('the motion tokens are read with today’s values as fallbacks and never declared', () => {
    for (const [name, fallback] of [
      ['--bs-marquee-scale', '1'],
      ['--bs-rv-from', '0'],
      ['--bs-rv-shift', '26px'],
    ] as const) {
      expect(declared(name), name).toBeUndefined();
      expect(GLOBAL_CSS).toContain(`var(${name}, ${fallback})`);
    }
    // Every colour token a theme writes is one global.css declares: a theme overrides, never
    // adds, so an unthemed page draws exactly what it drew before.
    for (const name of THEME_TOKEN_NAMES.slice(0, 8)) expect(declared(name), name).toBeDefined();
  });

  it('admin.css reads the theme first, with the brand colours as its fallbacks', () => {
    const block = root(ADMIN_CSS);
    expect(block).toContain(
      `--ad-primary: var(--bs-klein, ${DEFAULT_COLORS.primary.toLowerCase()});`,
    );
    expect(block).toContain(
      `--ad-primary-hover: var(--bs-cobalt, ${DEFAULT_COLORS.hover.toLowerCase()});`,
    );
    expect(block).toContain(`--ad-accent: var(--bs-sky, ${DEFAULT_COLORS.accent.toLowerCase()});`);
    // The admin tokens that follow the theme: each colour among them is in the gate's block,
    // or decorative (the accent, white on it is 2.56:1) or a shadow.
    const follows = [...block.matchAll(/--ad-([\w-]+):\s*([^;]+);/g)]
      .filter(([, , value]) => /var\(--bs-|var\(--ad-primary/.test(value!))
      .map(([, name]) => name!)
      .sort();
    expect(follows).toEqual([
      'accent',
      'primary',
      'primary-hover',
      'primary-shadow',
      'primary-soft',
      'primary-soft-2',
      'series-1',
    ]);
    for (const name of follows.filter((n) => n !== 'accent' && n !== 'primary-shadow')) {
      expect(ADMIN.colors[name], name).toBeDefined();
    }
  });

  it('the gate’s light accent tint at the brand colours is global.css’s', () => {
    expect(paletteOf(DEFAULT_COLORS).skySoft).toBe(DEFAULT_SKY_SOFT.toLowerCase());
  });
});
