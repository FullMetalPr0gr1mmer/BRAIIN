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
