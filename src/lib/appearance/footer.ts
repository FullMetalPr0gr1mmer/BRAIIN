import type { SocialLink } from '@schemas/siteProfile';
import type { Identity } from '@/lib/identity/fallback';
import { NETWORKS } from '@/lib/social/networks';

export { copyrightLine, DEFAULT_COPYRIGHT, type CopyrightParts } from './copyright';

// The public footer's settings (Admin v2 E6), pure so they are unit-tested
// (tests/lib/footerColumns.spec.ts): the copyright line from its template, and what the
// footer draws for each of U9's four settings (site_profile, 0102). Every default is the
// footer as built, so a site that saved nothing renders the same bytes
// (tests/render/siteChrome.spec.ts).

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
