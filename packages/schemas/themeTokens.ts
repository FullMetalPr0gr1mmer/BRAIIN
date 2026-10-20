import { z } from 'zod';

/**
 * Theme tokens are CSS CUSTOM PROPERTIES ONLY (CLAUDE.md §7). The key pattern and the
 * value pattern together are the CSP story: with no `'unsafe-inline'` in `style-src`,
 * a token is injected as `--name: value` inside one nonced <style> block, so a value
 * containing `;` or `}` would break out of the declaration and author arbitrary CSS.
 */
export const ThemeTokensSchema = z.record(
  z.string().regex(/^--[a-z0-9-]{1,60}$/, 'token names must be CSS custom properties'),
  z
    .string()
    .max(120)
    .regex(/^[^;{}<>\\]*$/, 'token values may not contain ; { } < > or backslash'),
);
