import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ThemeScreen, { THEME_FIELDS } from '@/components/admin/screens/theme/ThemeScreen';
import SitePreview from '@/components/admin/screens/theme/SitePreview';
import {
  ADMIN_PREVIEW_TOKENS,
  MARQUEE_OPTIONS,
  REVEAL_OPTIONS,
  derivedSettings,
  failureLines,
  gateView,
  settingsOf,
  typedMain,
  validColors,
  withMain,
} from '@/components/admin/screens/theme/model';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import { DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { paletteOf, simplePalette, type GateResult } from '@theme/gate';
import { DEFAULT_COLORS } from '@theme/palette';
import { ThemeSettingsSchema } from '@schemas/theme';
import { THEME_TOKEN_NAMES } from '@schemas/themeTokens';

// The theme editor (/admin/appearance/theme, Admin v2 E4): its pure half (model.ts) and its
// server markup. The browser journey is tests/admin/theme.e2e.ts; this pins what it relies on
// (the accessible names it finds controls by) and what no browser run would notice (a saved
// theme read back into the form, the CSP's no-style rule).

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

const SAVED = {
  v: 1,
  mode: 'advanced',
  colors: { primary: '#000000', hover: '#615757', accent: '#938A8D' },
  motion: { marquee: 'slowest', reveal: false },
};

describe('the form holds the settings the theme was saved with', () => {
  it('a saved theme, loaded through the field kit, is the theme the editor shows', () => {
    // rowToForm keeps a `json` field as text (JSON.stringify): the screen must read it back.
    const form = rowToForm(
      { id: 'x', name: 'Site theme', settings: SAVED, version: 3 },
      THEME_FIELDS,
    );
    expect(settingsOf(form['settings'])).toEqual(SAVED);
    // And what it sends is the object again, whichever way the form holds it.
    expect(formToPayload(form, THEME_FIELDS)['settings']).toEqual(SAVED);
    expect(formToPayload({ ...form, settings: SAVED }, THEME_FIELDS)['settings']).toEqual(SAVED);
  });

  it('anything else is the brand’s own settings, a fresh copy each time', () => {
    for (const value of [undefined, null, '', '{', '[]', 42, [], 'null']) {
      const settings = settingsOf(value);
      expect(settings, JSON.stringify(value)).toEqual(DEFAULT_THEME_SETTINGS);
      expect(settings).not.toBe(DEFAULT_THEME_SETTINGS);
      expect(settings.colors).not.toBe(DEFAULT_THEME_SETTINGS.colors);
    }
  });

  it('keeps a colour as typed, and drops a value of the wrong kind', () => {
    const settings = settingsOf({
      ...SAVED,
      colors: { primary: '#00', hover: 7, accent: '#938A8D' },
      motion: { marquee: 'faster', reveal: 'no' },
      extra: true,
    });
    expect(settings.colors).toEqual({ primary: '#00', hover: '#024CFF', accent: '#938A8D' });
    expect(settings.motion).toEqual({ marquee: 'normal', reveal: true });
    expect(Object.keys(settings).sort()).toEqual(['colors', 'mode', 'motion', 'v']);
  });
});

describe('what the screen draws from the settings', () => {
  it('no gate and no palette while a colour is half typed', () => {
    const typing = { ...DEFAULT_THEME_SETTINGS, colors: { ...DEFAULT_COLORS, hover: '#7F' } };
    expect(validColors(typing.colors)).toBeNull();
    expect(gateView(typing)).toEqual({ result: null, palette: null });
    expect(gateView(DEFAULT_THEME_SETTINGS).result?.ok).toBe(true);
    expect(gateView(DEFAULT_THEME_SETTINGS).palette).toEqual(paletteOf(DEFAULT_COLORS));
  });

  it('Simple: a main colour makes the whole palette; a half-typed one waits', () => {
    expect(withMain(DEFAULT_THEME_SETTINGS, '#0b6eb0').colors).toEqual(simplePalette('#0B6EB0'));
    expect(withMain(DEFAULT_THEME_SETTINGS, '#0024BC').colors).toEqual(DEFAULT_COLORS);
    const typing = withMain({ ...DEFAULT_THEME_SETTINGS, colors: SAVED.colors }, '#0B');
    expect(typing.colors).toEqual({ ...SAVED.colors, primary: '#0B' });
  });

  it('Simple, as typed: the main colour goes in alone; the palette follows, deferred (CR3)', () => {
    const simple = { ...DEFAULT_THEME_SETTINGS, mode: 'simple' as const };
    const typed = typedMain(simple, '#0B6EB0');
    expect(typed.colors).toEqual({ ...DEFAULT_COLORS, primary: '#0B6EB0' });
    expect(typed.motion).toEqual(simple.motion);
    // The deferred render makes the palette from it, as choosing it did before.
    expect(derivedSettings(typed, true)).toEqual(withMain(simple, '#0B6EB0'));
    // Nothing typed, Advanced mode, a half-typed colour, or a palette already made from the
    // main colour: the same object (nothing written back, no second gate).
    expect(derivedSettings(typed, false)).toBe(typed);
    const advanced = { ...typed, mode: 'advanced' as const };
    expect(derivedSettings(advanced, true)).toBe(advanced);
    const half = typedMain(simple, '#0B');
    expect(derivedSettings(half, true)).toBe(half);
    const made = withMain(simple, '#0B6EB0');
    expect(derivedSettings(made, true)).toBe(made);
  });

  it('says each failure once', () => {
    const failure = (message: string) => ({ message }) as GateResult['failures'][number];
    const result = {
      ok: false,
      failures: [failure('A.'), failure('B.'), failure('A.')],
      suggestions: {},
    } as GateResult;
    expect(failureLines(result)).toEqual(['A.', 'B.']);
    expect(failureLines(null)).toEqual([]);
  });

  it('offers motion that only reduces, in the schema’s values', () => {
    const marquee = ThemeSettingsSchema.innerType().shape.motion.shape.marquee.options;
    expect(MARQUEE_OPTIONS.map((o) => o.value)).toEqual(marquee);
    expect(MARQUEE_OPTIONS.map((o) => o.label)).toEqual(['Normal', 'Slower', 'Much slower']);
    expect(REVEAL_OPTIONS.map((o) => o.value)).toEqual(['on', 'off']);
  });

  it('previews the admin in the three tokens admin.css reads, and only those', () => {
    expect(Object.values(ADMIN_PREVIEW_TOKENS)).toEqual(['--bs-klein', '--bs-cobalt', '--bs-sky']);
    for (const name of Object.values(ADMIN_PREVIEW_TOKENS)) {
      expect(THEME_TOKEN_NAMES).toContain(name);
    }
  });
});

describe('the screen’s server markup', () => {
  const html = renderToStaticMarkup(createElement(ThemeScreen, { id: null, releaseMode: false }));

  it('the names the browser journey finds things by', () => {
    for (const name of ['Brand colours', 'Motion', 'What stays the same', 'Preview']) {
      expect(html, name).toMatch(new RegExp(`<h2 class="card__t" id="theme-[a-z]+">${name}</h2>`));
    }
    expect(html).toContain(
      '<legend class="visually-hidden">How do you want to set colours?</legend>',
    );
    expect(html).toContain('<legend class="visually-hidden">Clients marquee speed</legend>');
    expect(html).toContain('<legend class="visually-hidden">Sections</legend>');
    expect(html).toContain('Simple: one colour');
    expect(html).toContain('Advanced: every colour');
    expect(html).toMatch(/<label[^>]*for="theme-primary"[^>]*>Main colour/);
    expect(html).toContain('aria-label="Main colour: suggested colours"');
    expect(html).toContain('Save theme');
    expect(html).toContain('Reset to brand defaults');
    // The brand's own colours pass: no error note.
    expect(html).not.toContain('hard to read');
  });

  it('draws no empty card: the form’s own fields are all hidden (CR4)', () => {
    expect(html).not.toMatch(/<div class="card"><\/div>/);
    // Every card the screen draws has its heading.
    expect(html.match(/class="card"/g)).toHaveLength(4);
  });

  it('sets no style attribute: colours are SVG attributes (CSP, ui.md §1.6)', () => {
    expect(html).not.toMatch(/\sstyle=/);
    const preview = renderToStaticMarkup(
      createElement(SitePreview, { palette: paletteOf(DEFAULT_COLORS) }),
    );
    expect(preview).not.toMatch(/\sstyle=/);
    expect(preview).toContain('role="img"');
    expect(preview).toContain(`fill="${DEFAULT_COLORS.primary.toLowerCase()}"`);
    expect(preview).toContain(`fill="${DEFAULT_COLORS.accent.toLowerCase()}"`);
  });
});
