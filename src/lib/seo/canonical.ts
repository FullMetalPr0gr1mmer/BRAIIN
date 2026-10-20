import { localizedPath } from '@/lib/i18n';
import type { Locale } from '@schemas/primitives';

// A page's canonical override (`entity_seo.canonical_override`, Admin + SEO; Admin v2 U10
// D6). New values are site paths (CanonicalPathSchema), which SeoHead LOCALIZES: `/x` is
// `/x` on the English page and `/ar/x` on its Arabic twin, so each language stays
// self-canonical (CLAUDE.md Pillar 3). Values written before that rule may be absolute URLs;
// one on this site's origin is read as its path (an `/ar` prefix dropped, so the twin is
// derived the same way), and anything else (another origin, a scheme other than http(s),
// credentials, something unparsable) is ignored: a canonical pointing off-site would hand
// the page's ranking to whatever domain was typed into the box.

/** The override as a logical path (no `/ar`, no query or fragment), or null to ignore it. */
export function canonicalPath(override: string | null | undefined, base: string): string | null {
  const value = override?.trim();
  if (!value) return null;
  let url: URL;
  let origin: string;
  try {
    origin = new URL(base).origin;
    url = new URL(value, `${origin}/`);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password) return null;
  // `//host/x` and `/\host/x` resolve to another origin above; a path that is still ours:
  const path = url.pathname;
  if (path === '/ar' || path === '/ar/') return '/';
  if (path.startsWith('/ar/')) return path.slice(3);
  return path;
}

/** The canonical URL for one language: the override localized, else the page's own. */
export function localizedCanonical(
  override: string | null | undefined,
  locale: Locale,
  base: string,
  fallback: string,
): string {
  const path = canonicalPath(override, base);
  if (path === null) return fallback;
  return base.replace(/\/+$/, '') + localizedPath(path, locale);
}
