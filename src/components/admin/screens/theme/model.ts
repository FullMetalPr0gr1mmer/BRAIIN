import { normalizeColour } from '@theme/colour';
import { DEFAULT_THEME_SETTINGS } from '@theme/compile';
import { gate, paletteOf, simplePalette, type GateResult, type Palette } from '@theme/gate';
import { THEME_ROLES, type ThemeColors, type ThemeRole } from '@theme/palette';
import type { ThemeSettings } from '@schemas/theme';
import type { ThemeTokenName } from '@schemas/themeTokens';

// The theme editor's pure half (Admin v2 E4): what the screen draws from the settings it holds.
// No React, so tests/lib/themeEditor.spec.ts drives it in node.

type Row = Record<string, unknown>;

const MARQUEE = ['normal', 'slower', 'slowest'] as const;

/**
 * The settings a form holds, from whatever was loaded: a v1 theme as saved, else (no theme
 * yet, or a value of another shape) the brand's own. Colours are kept as typed, so a half
 * typed hex stays in the box; the gate and the server judge them.
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
  const v = value as Row;
  const colors = (v['colors'] && typeof v['colors'] === 'object' ? v['colors'] : {}) as Row;
  const motion = (v['motion'] && typeof v['motion'] === 'object' ? v['motion'] : {}) as Row;
  const colour = (role: ThemeRole) =>
    typeof colors[role] === 'string' ? (colors[role] as string) : base.colors[role];
  return {
    v: 1,
    mode: v['mode'] === 'advanced' ? 'advanced' : 'simple',
    colors: { primary: colour('primary'), hover: colour('hover'), accent: colour('accent') },
    motion: {
      marquee: (MARQUEE as readonly unknown[]).includes(motion['marquee'])
        ? (motion['marquee'] as ThemeSettings['motion']['marquee'])
        : base.motion.marquee,
      reveal: typeof motion['reveal'] === 'boolean' ? motion['reveal'] : base.motion.reveal,
    },
  };
}

export function cloneSettings(s: ThemeSettings): ThemeSettings {
  return { ...s, colors: { ...s.colors }, motion: { ...s.motion } };
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

export function gateView(settings: ThemeSettings): GateView {
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

export const REVEAL_OPTIONS = [
  { value: 'on', label: 'Fade in as you scroll' },
  { value: 'off', label: 'Show at once' },
] as const;
