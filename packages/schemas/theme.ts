import { z } from 'zod';
import { failuresFor } from '../theme/gate';
import {
  BUTTON_CHOICES,
  CORNER_CHOICES,
  DEFAULT_SHAPES,
  DEFAULT_TYPE,
  HEADING_CASES,
} from '../theme/shapes';

// The theme's settings (Admin v2 E4, AV-27; ui.md "Theme"): what the editor saves in
// custom_themes.settings, and the only input the server compiles the theme's tokens from
// (packages/theme/compile.ts). Strict at every level: a key this version does not know is
// refused, never carried into a release or the site.
//
//   colors   the three colours that follow the theme, `#RRGGBB` (stored upper case), and that
//            must pass the contrast gate (packages/theme/gate.ts), each failing pair an issue
//            on the colour it names first, with the pair in words
//   motion   settings that can only REDUCE motion (README "Appearance"): the marquee at its
//            normal speed or slower, and the reveal on scroll on or off
//   mode     how the editor shows the colours (one main colour, or each one); the stored
//            colours are the whole truth either way
//   shapes   (v2, Admin v2 E12, AV-32) the corners of cards, images and inputs (brand, square,
//            soft, round) and the buttons (pill, rounded, square): packages/theme/shapes.ts
//   type     (v2) the headings' weight (800 or 700, both bold) and case (uppercase or as
//            written)
//
// Versions: E4 saved `v: 1` (no shapes, no type). The schema reads both and answers v2 either
// way (a v1 theme is the brand's shapes and type), so the editor, the resource's toRow and a
// release's publish see one shape and the next save stores v2. The database's CHECK
// (app.theme_row_ok) still accepts a v1 row, so a theme saved before E12 stays valid and served.

export const THEME_SETTINGS_VERSION = 2 as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

export const HexColourSchema = z
  .string()
  .trim()
  .regex(HEX, 'Use a colour like #0024BC')
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

export const ThemeShapesSchema = z
  .object({ corners: z.enum(CORNER_CHOICES), buttons: z.enum(BUTTON_CHOICES) })
  .strict();

export const ThemeTypeSchema = z
  .object({
    headingWeight: z.union([z.literal(800), z.literal(700)]),
    headingCase: z.enum(HEADING_CASES),
  })
  .strict();

/** E4's settings, as saved before E12 (read, never written again). */
export const ThemeSettingsV1Schema = z
  .object({
    v: z.literal(1),
    mode: z.enum(['simple', 'advanced']),
    colors: ThemeColorsSchema,
    motion: ThemeMotionSchema,
  })
  .strict();

/** The settings a save stores since E12. */
export const ThemeSettingsV2Schema = z
  .object({
    v: z.literal(THEME_SETTINGS_VERSION),
    mode: z.enum(['simple', 'advanced']),
    colors: ThemeColorsSchema,
    motion: ThemeMotionSchema,
    shapes: ThemeShapesSchema,
    type: ThemeTypeSchema,
  })
  .strict();

type SettingsV2 = z.infer<typeof ThemeSettingsV2Schema>;

export const ThemeSettingsSchema = z
  .discriminatedUnion('v', [ThemeSettingsV1Schema, ThemeSettingsV2Schema])
  .transform((settings): SettingsV2 =>
    settings.v === THEME_SETTINGS_VERSION
      ? settings
      : {
          ...settings,
          v: THEME_SETTINGS_VERSION,
          shapes: { ...DEFAULT_SHAPES },
          type: { ...DEFAULT_TYPE },
        },
  )
  .superRefine((settings, ctx) => {
    // zod runs a refinement on a value whose fields already failed (a half-typed colour, a
    // number): the gate reads only three colours, so it waits until each one is one.
    const colors: unknown = settings?.colors;
    if (!colors || typeof colors !== 'object') return;
    const each = Object.values(colors as Record<string, unknown>);
    if (each.length !== 3 || !each.every((c) => typeof c === 'string' && HEX.test(c))) return;
    for (const failure of failuresFor(settings.colors)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['colors', failure.roles[0] ?? 'primary'],
        message: failure.message,
      });
    }
  });

export type ThemeSettings = z.output<typeof ThemeSettingsSchema>;
export type ThemeMotion = z.infer<typeof ThemeMotionSchema>;
export type ThemeShapesSettings = z.infer<typeof ThemeShapesSchema>;
export type ThemeTypeSettings = z.infer<typeof ThemeTypeSchema>;

/**
 * A theme's save (the `themes` resource, src/lib/admin/resources/themes.ts): its settings, from
 * which the server compiles the tokens, so no client writes a token (a `tokens` key sent anyway
 * is not part of the shape and is dropped). Here, not in admin.ts: the browser's shared admin
 * chunk carries that module whole, and these carry the gate (Admin v2 E4).
 */
export const ThemeWriteSchema = z.object({
  name: z.string().trim().min(1).max(200).default('Site theme'),
  settings: ThemeSettingsSchema,
  isActive: z.boolean().default(true),
});
/** An update: any of them, and the version it was read at (admin.ts `updatable`). */
export const ThemeUpdateSchema = ThemeWriteSchema.partial().extend({
  version: z.number().int().min(1),
});
