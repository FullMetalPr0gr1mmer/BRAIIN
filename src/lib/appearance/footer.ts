import type { Locale } from '@schemas/primitives';
import type { SocialLink } from '@schemas/siteProfile';
import type { Identity } from '@/lib/identity/fallback';
import { NETWORKS } from '@/lib/social/networks';

// The public footer's settings (Admin v2 E6), pure so they are unit-tested
// (tests/lib/footerSettings.spec.ts): the copyright line from its template, and what the
// footer draws for each of U9's four settings (site_profile, 0102). Every default is the
// footer as built, so a site that saved nothing renders the same bytes
// (tests/render/siteChrome.spec.ts).

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

/** One social account as the footer draws it: an icon link named by its network. */
export interface FooterSocial {
  network: SocialLink['network'];
  label: string;
  href: string;
  icon: string | null;
}

/**
 * The accounts the footer shows: none unless "Show social icons" is on; then every account
 * with "Show on the site" on (U9), in the saved order. The links were checked against each
 * network's host on write and again on read (SiteProfileRowSchema).
 */
export function footerSocials(identity: Identity): FooterSocial[] {
  if (!identity.footer.showSocial) return [];
  return identity.socials
    .filter((s) => s.visible !== false)
    .map((s) => ({
      network: s.network,
      label: NETWORKS[s.network].label,
      href: s.url,
      icon: NETWORKS[s.network].icon ?? null,
    }));
}

/**
 * The attributes the `<footer>` carries for its settings: `data-style="dark"` for the dark
 * style, nothing for the default light one (so the footer as built keeps its bytes).
 */
export function footerAttributes(identity: Identity): Record<string, string> {
  return identity.footer.style === 'dark' ? { 'data-style': 'dark' } : {};
}
