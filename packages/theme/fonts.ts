// The font catalogue (Admin v2 E13; README "a curated self-hosted font catalogue"; docs/fonts.md
// "The catalogue"): the families a theme can set the site in, closed and code-owned. Never a row,
// never a link to a font service, never an uploaded file (deviations.md: no Google or Adobe links,
// no raw uploads; CSP `font-src 'self'`, PDPL, the font budget). A family joins only as
// pre-subset woff2 files in public/fonts with measured metric-override fallback faces
// (packages/theme/fontFaces.ts), and every rule CLAUDE.md §6 sets is checked over the catalogue
// by tests/lib/fontCatalogue.spec.ts.
//
// Each family sets the pages of one script: a `latin` family the English pages
// (`--bs-font-sans`), an `arabic` family the Arabic pages (`--bs-font-ar`, with a Latin subset of
// its own for the Latin words in Arabic copy). The brand's family for each script is the one
// global.css and admin.css declare and their `:root` stacks name, so choosing it writes no token
// and a page is exactly what it was. Owner item O-21 (the families, with web licences) is open,
// so today each script has the brand's family only; the mechanism is whole and waits for data.
//
// This module is the light half (what the editor, the schema and the compiler need: ids, names,
// stacks, licences); the faces are packages/theme/fontFaces.ts, which only the server and the
// tests read.

export const FONT_SCRIPTS = ['latin', 'arabic'] as const;
export type FontScript = (typeof FONT_SCRIPTS)[number];

export interface FontLicence {
  /** The licence the family is used under. */
  name: string;
  /** The copyright notice the files carry (their name table, record 0), verbatim. */
  notice: string;
}

export interface FontFamily {
  /** The settings' value: lower case letters and hyphens. */
  id: string;
  /** The CSS family name of its web faces, and its name in the editor. */
  name: string;
  /** The pages it sets: latin (English, --bs-font-sans) or arabic (Arabic, --bs-font-ar). */
  script: FontScript;
  /** The brand's own family for its script: the one choice that writes no token. */
  brand: boolean;
  licence: FontLicence;
  /**
   * The full stack its pages' token holds: the family, its own fallback families (each declared
   * by its faces), then the generic tail. Letters, digits, spaces, quotes, commas and hyphens
   * only, so the token's pattern needs no escaping in JavaScript or in Postgres.
   */
  stack: string;
}

/** The OFL, the licence both brand families carry (the files' record 14 names it). */
const OFL = 'SIL Open Font License 1.1';

export const FONT_FAMILIES = [
  {
    id: 'archivo',
    name: 'Archivo',
    script: 'latin',
    brand: true,
    licence: {
      name: OFL,
      notice:
        'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)',
    },
    stack:
      "'Archivo', 'Archivo Fallback', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    id: 'almarai',
    name: 'Almarai',
    script: 'arabic',
    brand: true,
    licence: { name: OFL, notice: 'Copyright (c) 2019 by Almarai. All rights reserved.' },
    stack:
      "'Almarai', 'Almarai Fallback', 'Almarai Fallback Linux', 'Archivo', system-ui, 'Segoe UI', sans-serif",
  },
] as const satisfies readonly FontFamily[];

type Catalogue = (typeof FONT_FAMILIES)[number];
export type FontFamilyId = Catalogue['id'];
/** The ids of one script's families. */
export type FamilyIdOf<S extends FontScript> = Extract<Catalogue, { script: S }>['id'];

/** A theme's fonts: one family per script. */
export interface ThemeFonts {
  latin: FamilyIdOf<'latin'>;
  arabic: FamilyIdOf<'arabic'>;
}

/** The token each script's choice writes (the stylesheets' own `:root` stacks are the brand's). */
export const FONT_TOKENS = {
  latin: '--bs-font-sans',
  arabic: '--bs-font-ar',
} as const satisfies Record<FontScript, string>;
export type FontTokenName = (typeof FONT_TOKENS)[FontScript];

/** One script's families, the brand's first (the editor's order; the schema's enum). */
export function familiesOf<S extends FontScript>(
  script: S,
  families: readonly FontFamily[] = FONT_FAMILIES,
): FontFamily[] {
  const own = families.filter((f) => f.script === script);
  return [...own.filter((f) => f.brand), ...own.filter((f) => !f.brand)];
}

/** One script's ids, the brand's first: a non-empty list (every script has the brand's). */
export function familyIds<S extends FontScript>(script: S): [FamilyIdOf<S>, ...FamilyIdOf<S>[]] {
  return familiesOf(script).map((f) => f.id) as [FamilyIdOf<S>, ...FamilyIdOf<S>[]];
}

/** The settings' choices for each script (the schema's enums), the brand's first. */
export const LATIN_FAMILY_IDS = /* @__PURE__ */ familyIds('latin');
export const ARABIC_FAMILY_IDS = /* @__PURE__ */ familyIds('arabic');

/** The brand's family for a script. */
export function brandFamily(
  script: FontScript,
  families: readonly FontFamily[] = FONT_FAMILIES,
): FontFamily {
  const brand = families.find((f) => f.script === script && f.brand);
  if (!brand) throw new Error(`the font catalogue has no brand family for ${script}`);
  return brand;
}

/** The brand's fonts: what a theme starts from, what Reset brings back, what v1 and v2 read as. */
export const DEFAULT_FONTS: Readonly<ThemeFonts> = Object.freeze({
  latin: 'archivo',
  arabic: 'almarai',
});

/** A family by its id, within a script (undefined for an id off the script's list). */
export function familyById(
  script: FontScript,
  id: unknown,
  families: readonly FontFamily[] = FONT_FAMILIES,
): FontFamily | undefined {
  return families.find((f) => f.script === script && f.id === id);
}

/**
 * The family a page of this script is set in under a theme's tokens: the one whose stack the
 * script's token holds, else (no token, or a value no family has) the brand's.
 */
export function familyForTokens(
  script: FontScript,
  tokens: Readonly<Partial<Record<string, string | undefined>>> | null | undefined,
  families: readonly FontFamily[] = FONT_FAMILIES,
): FontFamily {
  const value = tokens?.[FONT_TOKENS[script]];
  return (
    families.find((f) => f.script === script && !f.brand && f.stack === value) ??
    brandFamily(script, families)
  );
}

export interface FontTokenRule {
  /** The settings key (`fonts.<key>`), the family's script. */
  key: FontScript;
  /** The family id, as `->>` reads it in SQL. */
  choice: string;
  token: FontTokenName;
  /** The stack the choice writes; null for the brand's (no token). */
  value: string | null;
}

/** Every family of the catalogue as a choice, with the token it writes (the brand's: none). */
export function fontTokenRules(families: readonly FontFamily[] = FONT_FAMILIES): FontTokenRule[] {
  return FONT_SCRIPTS.flatMap((script) =>
    familiesOf(script, families).map((f): FontTokenRule => ({
      key: script,
      choice: f.id,
      token: FONT_TOKENS[script],
      value: f.brand ? null : f.stack,
    })),
  );
}

/** The tokens a theme's fonts write: a non-brand family's stack, none for the brand's. */
export function fontTokens(
  fonts: Readonly<Record<FontScript, string>>,
  families: readonly FontFamily[] = FONT_FAMILIES,
): Partial<Record<FontTokenName, string>> {
  const out: Partial<Record<FontTokenName, string>> = {};
  for (const script of FONT_SCRIPTS) {
    const family = familyById(script, fonts[script], families);
    if (family && !family.brand) out[FONT_TOKENS[script]] = family.stack;
  }
  return out;
}

/** What a stack may hold: no character a regular expression or a declaration would read. */
export const STACK_CHARS = /^[A-Za-z0-9 ',-]+$/;

/**
 * The pattern a script's token takes: exactly one of the non-brand families' stacks. With none
 * (O-21 open) it takes nothing: `(?!)` fails at every position, in JavaScript and in Postgres
 * alike. packages/schemas/themeTokens.ts writes the result as a literal (it keeps to zod alone),
 * and tests/lib/fontCatalogue.spec.ts holds the two equal.
 */
export function fontTokenPattern(
  script: FontScript,
  families: readonly FontFamily[] = FONT_FAMILIES,
): RegExp {
  const stacks = familiesOf(script, families)
    .filter((f) => !f.brand)
    .map((f) => {
      if (!STACK_CHARS.test(f.stack)) throw new Error(`${f.id}: a stack outside ${STACK_CHARS}`);
      return f.stack;
    });
  return stacks.length === 0 ? /^(?!)/ : new RegExp(`^(?:${stacks.join('|')})$`);
}

/** What a tile draws in its family: the prototype's samples (screens_ops.js OPS_FONT_SAMPLES). */
export const FONT_SAMPLE: Readonly<Record<FontScript, string>> = Object.freeze({
  latin: 'Aa',
  arabic: 'أب',
});
