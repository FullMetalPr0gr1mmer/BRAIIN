import type { ThemeTokenName } from '../schemas/themeTokens';

// Shapes and type (Admin v2 E12, AV-32; ui.md "AV-32: Theme v2 (later): shapes and type
// tokens"): the closed choices a theme makes about the site's corners, buttons and headings,
// and the one token each choice writes. One table for the schema (the enums), the compiler
// (the tokens), the editor (the options) and the database (packages/theme/sql.ts writes it into
// app.theme_row_ok, which then requires each token to be exactly what the settings say).
//
//   corners        every card, image frame, panel and input radius of the public stylesheets
//                  reads `calc(<its own radius> * var(--bs-radius-scale, 1))`: one multiplier
//                  keeps each component's proportion (10 px inputs, 16 to 24 px cards)
//   buttons        the buttons read `var(--bs-btn-radius, 999px)`: a pill, 10 px or square
//   headingWeight  the headings and display lines set in 800 read
//                  `var(--bs-heading-weight, 800)`; only bold weights are offered (ui.md: 700 or
//                  800, Archivo has no 900), so every heading stays "large text" (WCAG) at the
//                  sizes the contrast pairs score it at
//   headingCase    those set in capitals read `var(--bs-heading-case, uppercase)`; Arabic has
//                  no case and keeps its `none` overrides
//
// The brand's own choice (first in each list) writes no token: the stylesheets' fallback IS the
// brand's value, so a theme at the brand's shapes and type changes nothing on any page.

export const CORNER_CHOICES = ['brand', 'square', 'soft', 'round'] as const;
export const BUTTON_CHOICES = ['pill', 'rounded', 'square'] as const;
export const HEADING_WEIGHTS = [800, 700] as const;
export const HEADING_CASES = ['uppercase', 'as-written'] as const;

export type CornerChoice = (typeof CORNER_CHOICES)[number];
export type ButtonChoice = (typeof BUTTON_CHOICES)[number];
export type HeadingWeight = (typeof HEADING_WEIGHTS)[number];
export type HeadingCase = (typeof HEADING_CASES)[number];

export interface ThemeShapes {
  corners: CornerChoice;
  buttons: ButtonChoice;
}
export interface ThemeType {
  headingWeight: HeadingWeight;
  headingCase: HeadingCase;
}

export const DEFAULT_SHAPES: Readonly<ThemeShapes> = Object.freeze({
  corners: 'brand',
  buttons: 'pill',
});
export const DEFAULT_TYPE: Readonly<ThemeType> = Object.freeze({
  headingWeight: 800,
  headingCase: 'uppercase',
});

/** The corner multipliers (the brand's is 1, the stylesheets' fallback). */
export const CORNER_SCALE: Readonly<Record<CornerChoice, number>> = Object.freeze({
  brand: 1,
  square: 0,
  soft: 0.5,
  round: 1.5,
});
/** The largest corner multiplier a theme can choose (the legibility gate's worst case). */
export const MAX_CORNER_SCALE = Math.max(...Object.values(CORNER_SCALE));

/** A button's radius in px for each style (the pill's 999 is the stylesheets' fallback). */
export const BUTTON_RADIUS: Readonly<Record<ButtonChoice, number>> = Object.freeze({
  pill: 999,
  rounded: 10,
  square: 0,
});

export interface ShapeTokenRule {
  group: 'shapes' | 'type';
  key: 'corners' | 'buttons' | 'headingWeight' | 'headingCase';
  /** The JSON type the setting is stored as. */
  kind: 'string' | 'number';
  /** The choice, as `->>` reads it in SQL. */
  choice: string;
  token: ThemeTokenName;
  /** What the choice writes; null for the brand's (no token). */
  value: string | null;
}

const fmt = (n: number) => String(n);

/** Every choice of every setting, with the token it writes (the brand's: none). */
export const SHAPE_TOKEN_RULES: readonly ShapeTokenRule[] = Object.freeze([
  ...CORNER_CHOICES.map((choice): ShapeTokenRule => ({
    group: 'shapes',
    key: 'corners',
    kind: 'string',
    choice,
    token: '--bs-radius-scale',
    value: choice === DEFAULT_SHAPES.corners ? null : fmt(CORNER_SCALE[choice]),
  })),
  ...BUTTON_CHOICES.map((choice): ShapeTokenRule => ({
    group: 'shapes',
    key: 'buttons',
    kind: 'string',
    choice,
    token: '--bs-btn-radius',
    value: choice === DEFAULT_SHAPES.buttons ? null : `${BUTTON_RADIUS[choice]}px`,
  })),
  ...HEADING_WEIGHTS.map((weight): ShapeTokenRule => ({
    group: 'type',
    key: 'headingWeight',
    kind: 'number',
    choice: fmt(weight),
    token: '--bs-heading-weight',
    value: weight === DEFAULT_TYPE.headingWeight ? null : fmt(weight),
  })),
  ...HEADING_CASES.map((choice): ShapeTokenRule => ({
    group: 'type',
    key: 'headingCase',
    kind: 'string',
    choice,
    token: '--bs-heading-case',
    value: choice === DEFAULT_TYPE.headingCase ? null : 'none',
  })),
]);

/** The four tokens shapes and type write, in theme.css's order. */
export const SHAPE_TOKEN_NAMES = [
  '--bs-radius-scale',
  '--bs-btn-radius',
  '--bs-heading-weight',
  '--bs-heading-case',
] as const satisfies readonly ThemeTokenName[];

/** The tokens a theme's shapes and type write (none for the brand's). */
export function shapeTokens(
  shapes: ThemeShapes,
  type: ThemeType,
): Partial<Record<(typeof SHAPE_TOKEN_NAMES)[number], string>> {
  const out: Partial<Record<(typeof SHAPE_TOKEN_NAMES)[number], string>> = {};
  const chosen: Record<ShapeTokenRule['key'], string> = {
    corners: shapes.corners,
    buttons: shapes.buttons,
    headingWeight: fmt(type.headingWeight),
    headingCase: type.headingCase,
  };
  for (const rule of SHAPE_TOKEN_RULES) {
    if (rule.value !== null && chosen[rule.key] === rule.choice) {
      out[rule.token as (typeof SHAPE_TOKEN_NAMES)[number]] = rule.value;
    }
  }
  return out;
}
