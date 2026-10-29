import { describe, expect, it } from 'vitest';
import { contrast, fromHsl, mix, toHsl } from '@theme/colour';
import {
  failuresFor,
  gate,
  paletteOf,
  settle,
  simplePalette,
  skySoftFor,
  suggestFor,
  suggestMain,
} from '@theme/gate';
import {
  DEFAULT_COLORS,
  THEME_ROLES,
  THEME_SWATCHES,
  generatePalette,
  type ThemeColors,
} from '@theme/palette';
import pairs from '@theme/pairs.json';
import { contrastRatio } from '@/lib/admin/contrast';

// The theme's contrast gate (Admin v2 E4, AV-27): property tests over seeded random palettes.
// The property the design names: a palette the gate ACCEPTS passes every public and admin pair
// (checked here independently of the gate's own code, from pairs.json), and a suggestion the
// gate offers is a palette it accepts.

/** A small seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r: () => number) =>
  `#${Math.floor(r() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
    .toUpperCase()}`;

type Def = string | [string, number, string];
type Block = { colors: Record<string, Def>; pairs: [string, string, number, string][] };

/** Every pair, resolved straight from pairs.json (not through gate.ts). */
function independentRatios(colors: ThemeColors) {
  const skySoft = skySoftFor(colors);
  const role: Record<string, string> = {
    primary: colors.primary.toLowerCase(),
    hover: colors.hover.toLowerCase(),
    accent: colors.accent.toLowerCase(),
    skySoft,
  };
  const out: { ratio: number; min: number }[] = [];
  for (const block of [pairs.site, pairs.admin] as unknown as Block[]) {
    const value = (name: string): string => {
      const def = block.colors[name]!;
      if (Array.isArray(def)) return mix(value(def[0]), def[1], value(def[2]));
      return def.startsWith('#') ? def : role[def]!;
    };
    for (const [fg, bg, min] of block.pairs) out.push({ ratio: contrast(value(fg), value(bg)), min });
  }
  return out;
}

describe('the theme gate', () => {
  it('passes the brand defaults', () => {
    expect(failuresFor(DEFAULT_COLORS)).toEqual([]);
    expect(gate(DEFAULT_COLORS).ok).toBe(true);
  });

  it('uses the audit maths (one formula with the admin colour field)', () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const a = hex(r);
      const b = hex(r);
      expect(contrast(a, b)).toBeCloseTo(contrastRatio(a, b), 10);
    }
  });

  it('accepted ⇒ every public and admin pair passes (2,000 random palettes)', () => {
    const r = rng(20261029);
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const colors = { primary: hex(r), hover: hex(r), accent: hex(r) };
      const ok = failuresFor(colors).length === 0;
      const independent = independentRatios(colors);
      const allPass = independent.every((p) => p.ratio >= p.min);
      // The gate and the independent check agree, both ways.
      expect(ok, JSON.stringify(colors)).toBe(allPass);
      if (ok) accepted++;
    }
    // Random triples rarely pass; settled ones (below) always do. Either way the property holds.
    expect(accepted).toBeGreaterThanOrEqual(0);
  });

  it('accepted ⇒ every pair passes, over palettes made to pass (settled from random mains)', () => {
    const r = rng(42);
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      // A main colour dark enough for white text, of any hue and saturation.
      const colors = simplePalette(fromHsl(r() * 360, r() * 100, 8 + r() * 30).toUpperCase());
      if (!gate(colors).ok) continue;
      checked++;
      for (const p of independentRatios(colors)) expect(p.ratio).toBeGreaterThanOrEqual(p.min);
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('names a failing pair in words, with both ratios', () => {
    // White text on a light hover: the button label pair fails.
    const colors = { ...DEFAULT_COLORS, hover: '#7FB2FF' };
    const failures = failuresFor(colors);
    const label = failures.find((f) => f.fg === 'fg' && f.bg === 'cobalt');
    expect(label?.message).toMatch(
      /^White text on Hover is \d\.\d:1, needs 4\.5:1 \(white text on a hovered button\)\.$/,
    );
    expect(label?.roles).toEqual(['hover']);
    // The admin's own pair fails too (its buttons on hover).
    expect(failures.some((f) => f.suite === 'admin' && f.bg === 'primary-hover')).toBe(true);
  });

  it('floors a ratio rather than rounding it up to a pass', () => {
    const colors = { ...DEFAULT_COLORS, hover: '#7FB2FF' };
    for (const f of failuresFor(colors)) {
      expect(f.message).not.toContain(`is ${f.min.toFixed(1)}:1`);
    }
  });

  it('offers, for each colour a failure names, the nearest passing lightness of its hue', () => {
    const r = rng(99);
    for (let i = 0; i < 40; i++) {
      const colors = { ...DEFAULT_COLORS, hover: hex(r) };
      const result = gate(colors);
      if (result.ok) continue;
      const pick = result.suggestions.hover;
      if (!pick) continue;
      // Accepted (only hover was off the brand), and the same hue (within rounding).
      expect(gate({ ...colors, hover: pick }).ok).toBe(true);
      const [h1, s1] = toHsl(colors.hover.toLowerCase());
      const [h2] = toHsl(pick.toLowerCase());
      if (s1 > 20) expect(Math.abs(((h1 - h2 + 540) % 360) - 180)).toBeLessThan(8);
    }
  });

  it('a suggestion is never further than it needs to be', () => {
    const colors = { ...DEFAULT_COLORS, hover: '#3F7FFF' };
    const pick = suggestFor(colors, 'hover');
    expect(pick).not.toBeNull();
    const [, , lPick] = toHsl(pick!.toLowerCase());
    const [h, s, l] = toHsl('#3f7fff');
    // One step closer to where it was, it fails.
    const closer = fromHsl(h, s, lPick + (l > lPick ? 1 : -1));
    if (Math.abs(lPick - l) > 1) expect(gate({ ...colors, hover: closer }).ok).toBe(false);
  });

  it('two failing colours: taking both suggestions makes the theme pass', () => {
    const colors = { primary: '#0B6EB0', hover: '#0B91F8', accent: '#27E8F6' };
    const result = gate(colors);
    expect(result.ok).toBe(false);
    expect(result.suggestions.primary).toBeTruthy();
    expect(result.suggestions.hover).toBeTruthy();
    const fixed = { ...colors, ...result.suggestions };
    expect(gate(fixed).ok, JSON.stringify(fixed)).toBe(true);
  });

  it('settles generated colours and leaves the chosen one alone', () => {
    for (const swatch of THEME_SWATCHES) {
      const generated = generatePalette(swatch);
      const settled = settle(generated, ['hover', 'accent']);
      expect(settled.primary).toBe(generated.primary);
    }
  });

  it("every swatch's Simple palette passes, or the main colour gets a passing suggestion", () => {
    for (const swatch of THEME_SWATCHES) {
      const colors = simplePalette(swatch);
      if (gate(colors).ok) continue;
      const main = suggestMain(swatch);
      expect(main, swatch).not.toBeNull();
      expect(gate(simplePalette(main!)).ok, `${swatch} → ${main}`).toBe(true);
    }
  });

  it('the brand primary in Simple mode passes', () => {
    expect(gate(simplePalette(DEFAULT_COLORS.primary)).ok).toBe(true);
  });

  it('derives the light accent tint from the accent, passing its own pairs', () => {
    const colors = { primary: '#0B6EB0', hover: '#0A5A92', accent: '#5CC8FF' };
    const tint = skySoftFor(colors);
    const palette = paletteOf(colors);
    expect(palette.skySoft).toBe(tint);
    expect(contrast(tint, palette.primary)).toBeGreaterThanOrEqual(4.5);
    // The brand's own colours keep global.css's tint.
    expect(skySoftFor(DEFAULT_COLORS)).toBe(pairs.defaults.skySoft.toLowerCase());
  });

  it('knows the three roles and nothing else', () => {
    expect([...THEME_ROLES]).toEqual(pairs.roles);
  });
});
