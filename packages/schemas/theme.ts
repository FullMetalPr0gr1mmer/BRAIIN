import { z } from 'zod';
import { failuresFor } from '../theme/gate';

// The theme's settings (Admin v2 E4, AV-27; ui.md "Theme"): what the editor saves in
// custom_themes.settings, and the only input the server compiles the theme's tokens from
// (src/lib/theme/compile.ts). Strict at every level: a key this version does not know is
// refused, never carried into a release or the site.
//
//   colors   the three colours that follow the theme, `#RRGGBB` (stored upper case), and that
//            must pass the contrast gate (packages/theme/gate.ts), each failing pair an issue
//            on the colour it names first, with the pair in words
//   motion   settings that can only REDUCE motion (README "Appearance"): the marquee at its
//            normal speed or slower, and the reveal on scroll on or off
//   mode     how the editor shows the colours (one main colour, or each one); the stored
//            colours are the whole truth either way

export const THEME_SETTINGS_VERSION = 1 as const;

export const HexColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #0024BC')
  .toUpperCase();

export const ThemeMotionSchema = z
  .object({
    marquee: z.enum(['normal', 'slower', 'slowest']),
    reveal: z.boolean(),
  })
  .strict();

export const ThemeColorsSchema = z
  .object({ primary: HexColourSchema, hover: HexColourSchema, accent: HexColourSchema })
  .strict();

export const ThemeSettingsSchema = z
  .object({
    v: z.literal(THEME_SETTINGS_VERSION),
    mode: z.enum(['simple', 'advanced']),
    colors: ThemeColorsSchema,
    motion: ThemeMotionSchema,
  })
  .strict()
  .superRefine((settings, ctx) => {
    for (const failure of failuresFor(settings.colors)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['colors', failure.roles[0] ?? 'primary'],
        message: failure.message,
      });
    }
  });

export type ThemeSettings = z.infer<typeof ThemeSettingsSchema>;
export type ThemeMotion = z.infer<typeof ThemeMotionSchema>;
