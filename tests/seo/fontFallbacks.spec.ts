import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// The metric-matched fallback faces (public/styles/global.css; docs/fonts.md 2b, 2c). The
// numbers were measured; this pins the structure that makes them apply where the site is
// measured: Arial on Windows/macOS (`Almarai Fallback`, `Archivo Fallback`), and on Linux —
// the CI runner included — Liberation Sans for Latin and DejaVu Sans for Arabic
// (`Almarai Fallback Linux`, and Liberation beside Arial under `Archivo Fallback`).

interface Face {
  family: string;
  weight: string;
  src: string[];
  range: string | null;
  size: number;
  ascent: number;
  descent: number;
  lineGap: number;
}

const css = readFileSync('public/styles/global.css', 'utf8');

const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
  const prop = (name: string) =>
    new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+);`).exec(body!)?.[1]?.replace(/\s+/g, ' ').trim();
  const pct = (name: string) => Number.parseFloat(prop(name) ?? 'NaN') / 100;
  return {
    family: (prop('font-family') ?? '').replace(/'/g, ''),
    weight: prop('font-weight') ?? '',
    src: [...(prop('src') ?? '').matchAll(/local\('([^']+)'\)|url\('([^']+)'\)/g)].map(
      (m) => m[1] ?? m[2]!,
    ),
    range: prop('unicode-range') ?? null,
    size: pct('size-adjust'),
    ascent: pct('ascent-override'),
    descent: pct('descent-override'),
    lineGap: pct('line-gap-override'),
  };
});

const familyFaces = (family: string) => faces.filter((f) => f.family === family);
const isArabic = (f: Face) => f.range?.includes('U+0600') ?? false;
const ARABIC_RANGE = familyFaces('Almarai').find(isArabic)?.range;
/** Almarai's box as FreeType/CoreText draw it: hhea = typo = 0.905 / 0.211 in every subset. */
const ALMARAI_ASCENT = 0.905;
const ALMARAI_DESCENT = 0.211;

describe('fallback faces', () => {
  it('parses what it tests', () => {
    expect(familyFaces('Almarai')).toHaveLength(6);
    expect(familyFaces('Almarai Fallback')).toHaveLength(6);
    expect(familyFaces('Almarai Fallback Linux')).toHaveLength(6);
    expect(familyFaces('Archivo Fallback')).toHaveLength(5);
    expect(ARABIC_RANGE).toBe('U+0020, U+00A0, U+0600-06FF, U+200C-200E, U+2010-2011');
  });

  it('the Arial family stays Arial-only — on Linux it must resolve nothing', () => {
    // Were any Linux font in here, it would claim the spaces (and, at 700, carry the Windows
    // line box) ahead of the Linux family.
    for (const f of familyFaces('Almarai Fallback')) {
      expect(
        f.src.every((s) => s.startsWith('Arial')),
        `${f.weight} ${f.range ?? 'latin'}`,
      ).toBe(true);
    }
  });

  it('Archivo’s fallback: a face per weight the site paints it at, regular below 600, bold from', () => {
    // One weight-normal face drew 600–800 in synthetic bold — Arial regular's widths, up to 11%
    // narrower than Archivo's at 800 — and a late Archivo re-wrapped every bold heading.
    const archivo = familyFaces('Archivo Fallback');
    expect(archivo.map((f) => f.weight || '400')).toEqual(['400', '500', '600', '700', '800']);
    for (const f of archivo) {
      const bold = Number(f.weight || 400) >= 600;
      const label = f.weight || '400';
      expect(f.src[0], label).toBe(bold ? 'Arial Bold' : 'Arial'); // Arial first: Windows/macOS as measured
      expect(f.src, label).toContain(bold ? 'Liberation Sans Bold' : 'Liberation Sans'); // Linux
      // Archivo's box is the same on every platform (USE_TYPO_METRICS set, hhea = typo).
      expect(f.ascent * f.size, label).toBeCloseTo(0.878, 3);
      expect(f.descent * f.size, label).toBeCloseTo(0.21, 3);
      expect(f.lineGap, label).toBe(0);
    }
    // Archivo widens with its weight; Arial Bold does not: the bold faces' size-adjust rises.
    const bold = archivo.filter((f) => Number(f.weight) >= 600).map((f) => f.size);
    expect(bold).toEqual([...bold].sort((a, b) => a - b));
  });

  it('the Linux family: Liberation for Latin, DejaVu for Arabic, at 400 / 700 / 800', () => {
    const linux = familyFaces('Almarai Fallback Linux');
    for (const w of ['400', '700', '800']) {
      const latin = linux.filter((f) => f.weight === w && !isArabic(f));
      const arabic = linux.filter((f) => f.weight === w && isArabic(f));
      expect(latin, w).toHaveLength(1);
      expect(arabic, w).toHaveLength(1);
      expect(latin[0]!.src[0], w).toBe(w === '400' ? 'Liberation Sans' : 'Liberation Sans Bold');
      expect(arabic[0]!.src[0], w).toBe(w === '400' ? 'DejaVu Sans' : 'DejaVu Sans Bold');
      expect(arabic[0]!.range, 'the same range as Almarai’s Arabic file').toBe(ARABIC_RANGE);
      // Liberation's widths are Arial's, so the Arial Latin face's size-adjust carries over.
      const arialLatin = familyFaces('Almarai Fallback').find((f) => f.weight === w && !f.range);
      expect(latin[0]!.size, w).toBe(arialLatin!.size);
    }
  });

  it('no Arabic-range face names Liberation Sans — it has no Arabic glyphs to give', () => {
    for (const f of faces.filter(isArabic)) {
      expect(
        f.src.some((s) => s.startsWith('Liberation')),
        `${f.family} ${f.weight}`,
      ).toBe(false);
    }
  });

  it('every Linux face draws Almarai’s box as Linux draws it — hhea, at every weight', () => {
    // NOT the Arial faces' box: Almarai 700 lacks USE_TYPO_METRICS, so only Windows draws it
    // at the win metrics (1.561em), and the Arial 700 faces copy that.
    for (const f of familyFaces('Almarai Fallback Linux')) {
      const label = `${f.weight} ${isArabic(f) ? 'arabic' : 'latin'}`;
      expect(f.ascent * f.size, label).toBeCloseTo(ALMARAI_ASCENT, 3);
      expect(f.descent * f.size, label).toBeCloseTo(ALMARAI_DESCENT, 3);
      expect(f.lineGap, label).toBe(0);
    }
  });

  it('the Arabic stack tries the Arial family first, then Linux’s', () => {
    const stack = /--bs-font-ar:\s*([^;]+);/.exec(css)?.[1]?.replace(/\s+/g, ' ') ?? '';
    const order = stack.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(order.slice(0, 3)).toEqual(['Almarai', 'Almarai Fallback', 'Almarai Fallback Linux']);
  });
});

describe('caps in em, not ch, where a swap moved them (R3-0)', () => {
  const work = readFileSync('public/styles/work.css', 'utf8');
  const block = (source: string, selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(
      source,
    )?.[1] ?? '';

  it('the All projects head’s paragraph — its 36ch moved the whole catalogue (CLS 0.58)', () => {
    expect(block(work, '.catalog-head__row p')).toMatch(/max-width: 20\.63em;/);
    expect(block(work, "html[dir='rtl'] .catalog-head__row p")).toMatch(/max-width: 19\.01em;/);
  });
});

describe('the consent copy’s box', () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(
      css,
    )?.[1] ?? '';

  it('is capped in em, not ch — a ch follows whichever font is painting (R3-0)', () => {
    expect(rule('.consent-text')).toMatch(/max-width: 34\.38em;/);
    expect(rule("html[dir='rtl'] .consent-text")).toMatch(/max-width: 31\.68em;/);
    expect(css).not.toMatch(/\.consent-text \{[^}]*\dch;/);
  });

  it('reserves the Arabic copy’s third line, in lh of a numeric line-height', () => {
    expect(rule("html[dir='rtl'] .consent-text")).toMatch(/min-height: 3lh;/);
    // `lh` follows the element's line-height: under `normal` it would change with the font.
    // The copy inherits body's; nothing on the banner sets its own.
    const bodyRules = [...css.matchAll(/(?:^|\n)body \{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(bodyRules.some((b) => /line-height: 1\.6;/.test(b))).toBe(true);
    for (const sel of ['.consent-banner', '.consent-text', "html[dir='rtl'] .consent-text"]) {
      expect(rule(sel), sel).not.toMatch(/line-height/);
    }
  });
});
