// SEO's closed values and limits (Admin v2 U10), apart from the Zod schemas that use them
// (packages/schemas/admin.ts re-exports every one), so an admin island can read them without
// carrying the schemas module into the browser.

/** The longest title and description an SEO override may hold, per language (U10 D14). */
export const SEO_TITLE_MAX = 120;
export const SEO_DESCRIPTION_MAX = 320;

/**
 * A page's own robots value (U10 D5): `null` follows the site default; otherwise index or
 * noindex, always "follow" (a page hidden from search still passes its links on). Closed so a
 * typo can never reach `<meta name="robots">`. Legacy free text is read leniently (anything
 * holding `noindex` counts as noindex: src/lib/seo/robots.ts) and written only as one of these.
 */
export const SEO_ROBOTS = ['index,follow', 'noindex,follow'] as const;
/** The site default's robots value: the page values, plus hiding the links too. */
export const SEO_DEFAULT_ROBOTS = ['index,follow', 'noindex,follow', 'noindex,nofollow'] as const;

/**
 * A canonical override (U10 D6): a path on this site, never another origin, a query or a
 * fragment, never `//host` or a backslash (the URL standard reads `/\host` as `//host`), and
 * never the Arabic twin's `/ar` path: SeoHead localizes it per language (`/x` → `/ar/x` on
 * the Arabic page), so each language stays self-canonical (CLAUDE.md Pillar 3).
 */
export const CANONICAL_PATH_PATTERN = /^\/(?!\/)(?!ar(?:\/|$))[^\s?#\\]*$/;
