import { normalizeColour } from '@theme/colour';
import { DEFAULT_THEME_SETTINGS } from '@theme/compile';
import {
  ARABIC_FAMILY_IDS,
  FONT_SAMPLE,
  LATIN_FAMILY_IDS,
  familiesOf,
  type FontFamily,
  type FontScript,
  type ThemeFonts,
} from '@theme/fonts';
import { gate, paletteOf, simplePalette, type GateResult, type Palette } from '@theme/gate';
import { THEME_ROLES, type ThemeColors, type ThemeRole } from '@theme/palette';
import {
  BUTTON_CHOICES,
  CORNER_CHOICES,
  HEADING_CASES,
  HEADING_WEIGHTS,
  upgradeThemeSettings,
  type ButtonChoice,
  type CornerChoice,
  type HeadingCase,
  type HeadingWeight,
} from '@theme/shapes';
import type { ThemeSettings } from '@schemas/theme';
import type { ThemeTokenName } from '@schemas/themeTokens';

// The theme editor's pure half (Admin v2 E4): what the screen draws from the settings it holds.
// No React, so tests/lib/themeEditor.spec.ts drives it in node.

type Row = Record<string, unknown>;

const MARQUEE = ['normal', 'slower', 'slowest'] as const;

/** One of a closed list, else the brand's. */
function oneOf<T>(list: readonly T[], value: unknown, fallback: T): T {
  return (list as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/**
 * The settings a form holds, from whatever was loaded: a theme as saved (v3, or an older one,
 * which has the brand's shapes, type and fonts), else (no theme yet, or a value of another
 * shape) the brand's own. Colours are kept as typed, so a half typed hex stays in the box; the
 * gate and the server judge them. Always v3: the next save stores the version the server writes.
 */
export function settingsOf(loaded: unknown): ThemeSettings {
  const base = DEFAULT_THEME_SETTINGS;
  // The field kit holds a `json` field as text once a row is loaded (rowToForm), and as the
  // object the screen sets after that: both are the same settings.
  let value = loaded;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return cloneSettings(base);
  // An older theme (E4's v1, E12's v2) is v3 at the brand's shapes, type and fonts: the one
  // upgrade. What is still off a list after it (a value no save wrote) is the brand's, below.
  const v = upgradeThemeSettings(value) as Row;
  const colors = (v['colors'] && typeof v['colors'] === 'object' ? v['colors'] : {}) as Row;
  const motion = (v['motion'] && typeof v['motion'] === 'object' ? v['motion'] : {}) as Row;
  const shapes = (v['shapes'] && typeof v['shapes'] === 'object' ? v['shapes'] : {}) as Row;
  const type = (v['type'] && typeof v['type'] === 'object' ? v['type'] : {}) as Row;
  const fonts = (v['fonts'] && typeof v['fonts'] === 'object' ? v['fonts'] : {}) as Row;
  const colour = (role: ThemeRole) =>
    typeof colors[role] === 'string' ? (colors[role] as string) : base.colors[role];
  return {
    v: 3,
    mode: v['mode'] === 'advanced' ? 'advanced' : 'simple',
    colors: { primary: colour('primary'), hover: colour('hover'), accent: colour('accent') },
    motion: {
      marquee: (MARQUEE as readonly unknown[]).includes(motion['marquee'])
        ? (motion['marquee'] as ThemeSettings['motion']['marquee'])
        : base.motion.marquee,
      reveal: typeof motion['reveal'] === 'boolean' ? motion['reveal'] : base.motion.reveal,
    },
    shapes: {
      corners: oneOf<CornerChoice>(CORNER_CHOICES, shapes['corners'], base.shapes.corners),
      buttons: oneOf<ButtonChoice>(BUTTON_CHOICES, shapes['buttons'], base.shapes.buttons),
    },
    type: {
      headingWeight: oneOf<HeadingWeight>(
        HEADING_WEIGHTS,
        type['headingWeight'],
        base.type.headingWeight,
      ),
      headingCase: oneOf<HeadingCase>(HEADING_CASES, type['headingCase'], base.type.headingCase),
    },
    fonts: {
      latin: oneOf<ThemeFonts['latin']>(LATIN_FAMILY_IDS, fonts['latin'], base.fonts.latin),
      arabic: oneOf<ThemeFonts['arabic']>(ARABIC_FAMILY_IDS, fonts['arabic'], base.fonts.arabic),
    },
  };
}

export function cloneSettings(s: ThemeSettings): ThemeSettings {
  return {
    ...s,
    colors: { ...s.colors },
    motion: { ...s.motion },
    shapes: { ...s.shapes },
    type: { ...s.type },
    fonts: { ...s.fonts },
  };
}

/** The three colours, each `#RRGGBB`, or null while any one is not a colour yet. */
export function validColors(colors: Readonly<Record<ThemeRole, string>>): ThemeColors | null {
  const out = {} as ThemeColors;
  for (const role of THEME_ROLES) {
    const hex = normalizeColour(colors[role]);
    if (!hex) return null;
    out[role] = hex;
  }
  return out;
}

export interface GateView {
  /** Null while a colour is still being typed. */
  result: GateResult | null;
  /** The palette the site would wear (the derived tint included), when the colours are valid. */
  palette: Palette | null;
}

export function gateView(settings: Pick<ThemeSettings, 'colors'>): GateView {
  const colors = validColors(settings.colors);
  if (!colors) return { result: null, palette: null };
  return { result: gate(colors), palette: paletteOf(colors) };
}

/** Simple mode's main colour chosen: the whole palette, made from it (settled by the gate). */
export function withMain(settings: ThemeSettings, main: string): ThemeSettings {
  const hex = normalizeColour(main);
  if (!hex) return { ...settings, colors: { ...settings.colors, primary: main } };
  return { ...settings, colors: simplePalette(hex) };
}

/**
 * Simple mode's main colour as typed or dragged: into the form at once and nothing else, so the
 * box keeps up with the keyboard and the picker (E4 code review CR3). The palette made from it
 * follows in a deferred render (derivedSettings).
 */
export function typedMain(settings: ThemeSettings, main: string): ThemeSettings {
  return { ...settings, colors: { ...settings.colors, primary: main } };
}

/**
 * What the screen shows and saves for the settings it holds: in Simple mode, once a main colour
 * has been typed, the palette made from it (withMain); otherwise the settings themselves, the
 * same object when nothing changes. The settling is the slow part, so the screen runs this in a
 * deferred render that React drops when a newer colour arrives (CR3).
 */
export function derivedSettings(settings: ThemeSettings, mainTyped: boolean): ThemeSettings {
  if (!mainTyped || settings.mode !== 'simple') return settings;
  const next = withMain(settings, settings.colors.primary);
  const same = THEME_ROLES.every((role) => next.colors[role] === settings.colors[role]);
  return same ? settings : next;
}

/** The messages to show, each once (a pair the site and the admin share reads once). */
export function failureLines(result: GateResult | null): string[] {
  if (!result) return [];
  return [...new Set(result.failures.map((f) => f.message))];
}

export const ROLE_LABEL: Record<ThemeRole, string> = {
  primary: 'Primary',
  hover: 'Hover',
  accent: 'Accent',
};

/** The custom properties the admin previews itself in (only the three it reads). */
export const ADMIN_PREVIEW_TOKENS: Readonly<Record<ThemeRole, ThemeTokenName>> = {
  primary: '--bs-klein',
  hover: '--bs-cobalt',
  accent: '--bs-sky',
};

/** The marquee speeds, in words. "Faster" is not offered: the theme only reduces motion. */
export const MARQUEE_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'slower', label: 'Slower' },
  { value: 'slowest', label: 'Much slower' },
] as const;

/** The corners of cards, images and inputs, in words (packages/theme/shapes.ts). */
export const CORNER_OPTIONS = [
  { value: 'brand', label: 'Brand' },
  { value: 'square', label: 'Square' },
  { value: 'soft', label: 'Soft' },
  { value: 'round', label: 'Round' },
] as const satisfies readonly { value: CornerChoice; label: string }[];

export const BUTTON_OPTIONS = [
  { value: 'pill', label: 'Pill' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'square', label: 'Square' },
] as const satisfies readonly { value: ButtonChoice; label: string }[];

/** A heading weight as a segmented control's value (a radio's value is text). */
export type WeightValue = `${HeadingWeight}`;

/**
 * Both bold: a heading stays large, easy to read text at any weight offered (ui.md AV-32). Tied
 * to HEADING_WEIGHTS by type (E12 code review CR8): a value that is not a weight offered does
 * not compile.
 */
export const WEIGHT_OPTIONS = [
  { value: '800', label: 'Extra bold' },
  { value: '700', label: 'Bold' },
] as const satisfies readonly { value: WeightValue; label: string }[];

/** A weight as the control shows it. */
export function weightValue(weight: HeadingWeight): WeightValue {
  return `${weight}`;
}

/** The control's value as a weight: one of HEADING_WEIGHTS, else the brand's (checked, not cast). */
export function weightOf(value: string): HeadingWeight {
  return oneOf<HeadingWeight>(
    HEADING_WEIGHTS,
    Number(value),
    DEFAULT_THEME_SETTINGS.type.headingWeight,
  );
}

export const CASE_OPTIONS = [
  { value: 'uppercase', label: 'Capitals' },
  { value: 'as-written', label: 'As written' },
] as const satisfies readonly { value: HeadingCase; label: string }[];

/** The two groups of the Fonts card: the pages each script's family sets (E13). */
export const FONT_GROUPS = [
  { script: 'latin', label: 'English pages' },
  { script: 'arabic', label: 'Arabic pages' },
] as const satisfies readonly { script: FontScript; label: string }[];

/** A tile of the Fonts card: a family of the catalogue, drawn in itself (FONT_SAMPLE). */
export interface FontOption {
  value: FontFamily['id'];
  name: string;
  /** The family's stack: the tile's sample and the site sample are drawn in it. */
  stack: string;
  sample: string;
  /** Its licence, in words. */
  licence: string;
  brand: boolean;
}

/** One script's tiles, the brand's first (the catalogue's order). */
export function fontOptions(script: FontScript): FontOption[] {
  return familiesOf(script).map((f) => ({
    value: f.id,
    name: f.name,
    stack: f.stack,
    sample: FONT_SAMPLE[script],
    licence: f.licence.name,
    brand: f.brand,
  }));
}

/** The stack a theme's family for a script is drawn in (the brand's for an id off the list). */
export function fontStack(fonts: ThemeFonts, script: FontScript): string {
  const options = fontOptions(script);
  return (options.find((o) => o.value === fonts[script]) ?? options[0]!).stack;
}

/** The settings with a script's family chosen: one of that script's, else unchanged. */
export function withFont(settings: ThemeSettings, script: FontScript, id: string): ThemeSettings {
  if (!fontOptions(script).some((o) => o.value === id)) return settings;
  return { ...settings, fonts: { ...settings.fonts, [script]: id } as ThemeFonts };
}

export const REVEAL_OPTIONS = [
  { value: 'on', label: 'Fade in as you scroll' },
  { value: 'off', label: 'Show at once' },
] as const;
