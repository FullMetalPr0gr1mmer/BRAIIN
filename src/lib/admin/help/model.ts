import { HELP_LIMITS, type HelpBody } from '@schemas/help';

// The help centre's shapes and pure rules (Admin v2 U16), shared by the server (the API
// and /admin/help) and the drawer in the browser. Nothing here reads the database or the
// capability matrix: which guides a role is shown is decided on the server
// (src/lib/admin/help/index.ts), and only what the role may see reaches the client.

/** A guide as a list shows it. English only: the admin is in English (ui.md §0). */
export interface HelpGuide {
  slug: string;
  title: string;
  minutes: number;
  tags: string[];
}

/** A guide to read, in both languages: the drawer and the page offer the Arabic text too. */
export interface HelpArticle extends HelpGuide {
  titleAr: string;
  body: HelpBody;
}

/** GET /api/admin/help: every guide the role may read, and which are for the screen. */
export interface HelpIndex {
  guides: HelpGuide[];
  /** Slugs of the guides for the screen the drawer was opened on, in the list's order. */
  onScreen: string[];
}

export type HelpLang = 'en' | 'ar';

/**
 * Where a guide is read without JS (and where a row links, so a new tab works too). The
 * screen it was reached from rides along, so the page's "All guides" lists that screen's
 * guides first and its language switch keeps it.
 */
export function guideHref(slug: string, screen?: string | null): string {
  const href = `/admin/help?guide=${encodeURIComponent(slug)}`;
  return screen ? `${href}&screen=${encodeURIComponent(screen)}` : href;
}

/** The help page for a screen: the topbar's "?" without JS. */
export function helpHrefFor(screen: string): string {
  return `/admin/help?screen=${encodeURIComponent(screen)}`;
}

/**
 * A screen to look guides up for, from a query string or the browser's location: an admin
 * path (`/admin` or below), lower case, no query or fragment, or null. Anything else is
 * ignored rather than refused: it only chooses which guides come first.
 */
export function screenOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const path = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return /^\/admin(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/.test(path) ? path : null;
}

/**
 * Is a guide for this screen? It is when one of its screens is the path or a page below it
 * (`/admin/services` covers `/admin/services/<id>`). The dashboard, `/admin`, covers only
 * itself, as the menu's current-link rule has it (src/lib/admin/nav).
 */
export function isOnScreen(screens: readonly string[], path: string): boolean {
  return screens.some(
    (screen) => screen === path || (screen !== '/admin' && path.startsWith(`${screen}/`)),
  );
}

/**
 * Up to `limit` other guides sharing a tag with this one, in the list's order: the
 * prototype's "Related". Picked from the guides the caller was given, so a related guide is
 * always one the role may read.
 */
export function relatedTo(
  article: Pick<HelpGuide, 'slug' | 'tags'>,
  guides: readonly HelpGuide[],
  limit = 3,
): HelpGuide[] {
  return guides
    .filter((g) => g.slug !== article.slug && g.tags.some((tag) => article.tags.includes(tag)))
    .slice(0, limit);
}

/** Half of a UTF-16 surrogate pair, alone: what `Array.from` yields for a broken pair. */
const LONE_SURROGATE = /^[\ud800-\udfff]$/;

/**
 * A search as the server runs it (CLAUDE.md §3, the search endpoint's rule): control
 * characters and lone surrogates stripped, trimmed, at most 64 characters. Under two
 * characters searches nothing.
 *
 * Counted and cut by code points, as PostgreSQL's char_length counts them, never by UTF-16
 * units: a cut through an emoji would leave half a surrogate pair, which no JSON or URL
 * encoder can send (the database refuses it as JSON, `encodeURIComponent` throws).
 */
export function cleanHelpQuery(raw: string): string {
  const kept = Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''))
    .filter((ch) => !LONE_SURROGATE.test(ch))
    .join('')
    .trim();
  return Array.from(kept).slice(0, HELP_LIMITS.query).join('');
}

export const MIN_QUERY = 2;

/** "3 min read" (the prototype's badge). */
export function readingTime(minutes: number): string {
  return `${minutes} min read`;
}
