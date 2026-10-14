// What the built-in copy modules (src/lib/sections/copy/<type>.ts) are written in.

/**
 * The built-in values of a section type's copy fields, in the shape of its CMS content
 * (packages/schemas/sections.ts): every named field present, each a `{ en, ar }` pair (or
 * an accent range, or a list of them) exactly as an editor would author it. So a page
 * editor can show the built-in text in the fields, and store only what differs.
 */
export type BuiltIn<Content, Field extends keyof Content> = {
  readonly [F in Field]-?: Exclude<Content[F], undefined>;
};

/** The token copy names the studio by, filled from the public identity (`site_profile`). */
export const BRAND = '%brand%';

/**
 * `%brand%` → the brand. A function replacement: a brand is copied as written, never read
 * as a `$&`-style replacement pattern.
 */
export function fillBrand(text: string, brand: string): string {
  return text.replaceAll(BRAND, () => brand);
}

/**
 * `{name}` tokens → their values ("Since {year}", "{i} of {n}"). A function replacement,
 * like fillBrand; a token with no value stays as written.
 */
export function fillTokens(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{(\w+)\}/g, (token, name: string) => values[name] ?? token);
}
