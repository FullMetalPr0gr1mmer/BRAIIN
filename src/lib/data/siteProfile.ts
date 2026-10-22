import { SiteProfileRowSchema } from '@schemas/siteProfile';
import { PUBLIC_MEDIA_COLUMNS, PublicMediaRowSchema } from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import { IDENTITY_FALLBACK, type Identity } from '@/lib/identity/fallback';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRow, reportLoadError } from './parse';
import { contentClient } from './source';

// Public identity (brand, contact channels, location, socials) — `public.site_profile`,
// anon-readable since migration 0019, tenant-fenced by RLS like every public read.
//
// Always returns an Identity: the row mapped to camelCase, or IDENTITY_FALLBACK when the
// database is unconfigured/unreachable or the row is missing/invalid. Every one of those
// is logged, so a site running on the fallback is diagnosable rather than just "fine".
//
// Admin v2 U9 (0102) adds the tagline, the phone, the map link, the footer settings and the
// icons' ids. Each new field parses on its own (SiteProfileRowSchema), so a bad value costs
// that field, never the brand. The icons themselves are a SEPARATE read (getSiteIcons), never
// an embed in this one: a media read that failed here would drop the whole identity to the
// fallback on every page.

export const SITE_PROFILE_COLUMNS =
  'brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,' +
  'address_locality,address_country,founded_year,socials,accepting_applications,updated_at,' +
  'tagline,phone_e164,phone_display,map_url,favicon_media_id,app_icon_media_id,' +
  'footer_copyright,footer_style,footer_show_email,footer_show_social';

export async function getSiteProfile(): Promise<Identity> {
  if (!supabaseConfigured()) return IDENTITY_FALLBACK;
  try {
    const { data, error } = await contentClient()
      .from('site_profile')
      .select(SITE_PROFILE_COLUMNS)
      .maybeSingle();
    if (error) {
      reportLoadError('site_profile', error);
      return IDENTITY_FALLBACK;
    }
    if (!data) {
      console.warn('[content] no site_profile row for the launch tenant — using the code fallback');
      return IDENTITY_FALLBACK;
    }
    const row = parseRow(SiteProfileRowSchema, data, 'site_profile');
    if (!row) return IDENTITY_FALLBACK;
    return {
      brandName: row.brand_name,
      legalName: row.legal_name,
      contactEmail: row.contact_email,
      whatsappE164: row.whatsapp_e164,
      whatsappDisplay: row.whatsapp_display,
      location: row.location,
      addressLocality: row.address_locality,
      addressCountry: row.address_country,
      foundedYear: row.founded_year,
      socials: row.socials,
      acceptingApplications: row.accepting_applications,
      tagline: row.tagline ?? null,
      phoneE164: row.phone_e164 ?? null,
      phoneDisplay: row.phone_e164 ? (row.phone_display ?? null) : null,
      mapUrl: row.map_url ?? null,
      faviconMediaId: row.favicon_media_id ?? null,
      appIconMediaId: row.app_icon_media_id ?? null,
      footer: {
        copyright: row.footer_copyright ?? null,
        style: row.footer_style ?? 'light',
        showEmail: row.footer_show_email ?? true,
        showSocial: row.footer_show_social ?? false,
      },
    };
  } catch (err) {
    reportLoadError('site_profile', err);
    return IDENTITY_FALLBACK;
  }
}

/** The site's icons (Admin v2 U9): each an uploaded square image, or null. */
export interface SiteIcons {
  favicon: ImageRef | null;
  appIcon: ImageRef | null;
}

const NO_ICONS: SiteIcons = { favicon: null, appIcon: null };

/** The smallest side an icon may have (0102's trigger says the same). */
export const ICON_MIN_PX = 512;

/** An icon is an UPLOADED image (`storage`), square, at least 512 px; anything else is none. */
function iconOf(row: unknown): ImageRef | null {
  const parsed = PublicMediaRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.provider !== 'storage') return null;
  const ref = imageRef(parsed.data);
  if (!ref || ref.width !== ref.height || ref.width < ICON_MIN_PX) return null;
  return ref;
}

/**
 * The icons the identity names, in ONE read of `media_assets` (anon reads them through 0102's
 * branch of media_assets_public_read). Never throws: no icon set, an error, a row that is not
 * an uploaded square image of at least 512 px, each is "no icon", so nothing is linked.
 */
export async function readSiteIcons(identity: Identity): Promise<SiteIcons> {
  const ids = [identity.faviconMediaId, identity.appIconMediaId].filter(
    (id): id is string => typeof id === 'string',
  );
  if (ids.length === 0 || !supabaseConfigured()) return NO_ICONS;
  try {
    const { data, error } = await contentClient()
      .from('media_assets')
      .select(PUBLIC_MEDIA_COLUMNS)
      .in('id', [...new Set(ids)]);
    if (error) {
      reportLoadError('media_assets (site icons)', error);
      return NO_ICONS;
    }
    const byId = new Map(
      (Array.isArray(data) ? (data as unknown as { id?: unknown }[]) : []).map((row) => [
        row.id,
        row,
      ]),
    );
    return {
      favicon: identity.faviconMediaId ? iconOf(byId.get(identity.faviconMediaId)) : null,
      appIcon: identity.appIconMediaId ? iconOf(byId.get(identity.appIconMediaId)) : null,
    };
  } catch (err) {
    reportLoadError('media_assets (site icons)', err);
    return NO_ICONS;
  }
}
