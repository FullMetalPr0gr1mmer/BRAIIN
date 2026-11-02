import type { Locale } from '@schemas/primitives';

// The footer's copyright line from its template (Admin v2 E6): one small module, shared by the
// public footer (through ./footer.ts) and the admin's sketch of it, so both fill the
// placeholders the same way and the admin chunk carries nothing else of the public side.

/** The built-in line: the footer as built, "© 2026 Braiin Statiion. Jeddah, Saudi Arabia". */
export const DEFAULT_COPYRIGHT = '© {year} {brand}. {place}';

/** What the placeholders become. */
export interface CopyrightParts {
  /** The year as the locale writes it (Arabic-Indic digits in Arabic, as the footer always has). */
  year: string;
  /** The site name (site_profile, CLAUDE.md §1: the brand is data). */
  brand: string;
  /** The location. */
  place: string;
}

/**
 * The copyright line: the saved template in this locale, else the built-in line, with
 * `{year}`, `{brand}` and `{place}` filled in. Each placeholder is replaced once, in one pass,
 * so a brand or place that itself contains "{year}" is never filled again. The result is
 * text: the page escapes it.
 */
export function copyrightLine(
  template: { en: string; ar: string } | null | undefined,
  locale: Locale,
  parts: CopyrightParts,
): string {
  const source = template?.[locale]?.trim() || DEFAULT_COPYRIGHT;
  return source.replace(/\{(year|brand|place)\}/g, (_, key: keyof CopyrightParts) => parts[key]);
}
