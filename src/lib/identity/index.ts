import type { Locale } from '@schemas/primitives';
import { getSiteProfile, readSiteIcons, type SiteIcons } from '@/lib/data/siteProfile';
import type { Identity } from './fallback';

export type { Identity } from './fallback';
export type { SiteIcons } from '@/lib/data/siteProfile';
export { IDENTITY_FALLBACK } from './fallback';

// The public identity, once per request.
//
// The header, the footer, <SeoHead>, the JSON-LD and the page itself all need the brand,
// and Astro renders them as separate components with no shared scope. Each calling
// getSiteProfile() would be five anon round-trips for one row, so the first caller stores
// the PROMISE on `Astro.locals` (request-scoped) and everyone after awaits the same one.
// Storing the promise rather than the value is what makes concurrent callers share the
// fetch instead of racing to start their own.
//
// getSiteProfile() never throws — it degrades to IDENTITY_FALLBACK — so neither does this.

type IdentityLocals = Pick<App.Locals, 'identity'>;
type IconLocals = Pick<App.Locals, 'identity' | 'siteIcons'>;

export function getIdentity(locals: IdentityLocals): Promise<Identity> {
  locals.identity ??= getSiteProfile();
  return locals.identity;
}

/** The displayed brand in one locale. Arabic is required on the row, so no fallback. */
export function brandName(identity: Identity, locale: Locale): string {
  return identity.brandName[locale];
}

/**
 * The site's icons (Admin v2 U9), once per request: the identity's ids, then one media read
 * (src/lib/data/siteProfile.ts readSiteIcons). Never throws; no icon set reads nothing.
 */
export function getSiteIcons(locals: IconLocals): Promise<SiteIcons> {
  locals.siteIcons ??= getIdentity(locals).then(readSiteIcons);
  return locals.siteIcons;
}
