import type { Locale } from '@schemas/primitives';

// Path-based i18n: `/` (EN) + `/ar/` (AR). Helpers to derive locale, direction,
// the logical (locale-stripped) path, and reciprocal hreflang twins (CLAUDE.md Pillar 3).

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALES: readonly Locale[] = ['en', 'ar'];

export function localeFromPath(pathname: string): Locale {
  return pathname === '/ar' || pathname.startsWith('/ar/') ? 'ar' : 'en';
}

export function dir(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/** Strip the locale prefix → the canonical logical path used to build twins. */
export function toLogicalPath(pathname: string): string {
  if (pathname === '/ar') return '/';
  if (pathname.startsWith('/ar/')) return pathname.slice(3) || '/';
  return pathname || '/';
}

/** Map a logical path to its localized URL path. */
export function localizedPath(logicalPath: string, locale: Locale): string {
  const clean = logicalPath.startsWith('/') ? logicalPath : `/${logicalPath}`;
  if (locale === 'ar') return clean === '/' ? '/ar' : `/ar${clean}`;
  return clean;
}

/**
 * Read a bilingual field in the requested locale, falling back to EN.
 *
 * Centralises the `x[locale] ?? x.en ?? fallback` chain that was repeated in every
 * component. Worth having in one place: the fallback direction is a Pillar-3 decision
 * (EN is `x-default`, so EN is the only legal fallback — never AR), and a component that
 * got the chain subtly wrong would silently degrade an Arabic page rather than fail.
 *
 * Accepts the optional-AR prose shape; the required-AR scalar shape assigns to it too.
 */
export function pickLocale(
  // `ar?: string | undefined`, not `ar?: string`: under `exactOptionalPropertyTypes` the
  // two are different types, and Zod's inferred output uses the explicit-undefined form.
  field: { en: string; ar?: string | undefined } | null | undefined,
  locale: Locale,
  fallback = '',
): string {
  if (!field) return fallback;
  const preferred = locale === 'ar' ? field.ar : field.en;
  // `||` not `??` — an empty string is as unusable as a missing one.
  return preferred || field.en || fallback;
}

/**
 * Like pickLocale, but with NO cross-language fallback: returns '' when the requested
 * locale has no value.
 *
 * Use for machine-read METADATA (meta description, og:description, JSON-LD description).
 * Prose fields let Arabic lag English by design, so pickLocale's EN fallback would put an
 * English description on a page that declares `lang="ar"` and `og:locale=ar_SA`. That is
 * a language mismatch — a worse signal to a search engine than simply having no
 * description, and it is invisible to a human reviewing the Arabic page. Visible body
 * copy still uses pickLocale: a reader is better served by English text than by a blank.
 */
export function pickLocaleStrict(
  field: { en: string; ar?: string | undefined } | null | undefined,
  locale: Locale,
): string {
  if (!field) return '';
  return (locale === 'ar' ? field.ar : field.en) || '';
}

/** Locale-aware medium date from an ISO string; '' when null (shared by blog index/detail). */
export function formatDate(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }).format(
    new Date(iso),
  );
}

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

/** Reciprocal hreflang pairs + x-default → EN (CLAUDE.md Pillar 3). */
export function hreflangAlternates(logicalPath: string, siteUrl: string): HreflangAlternate[] {
  const base = siteUrl.replace(/\/$/, '');
  return [
    { hreflang: 'en', href: base + localizedPath(logicalPath, 'en') },
    { hreflang: 'ar', href: base + localizedPath(logicalPath, 'ar') },
    { hreflang: 'x-default', href: base + localizedPath(logicalPath, 'en') },
  ];
}
