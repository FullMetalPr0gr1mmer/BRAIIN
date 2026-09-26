import { SiteProfileRowSchema } from '@schemas/siteProfile';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { IDENTITY_FALLBACK, type Identity } from '@/lib/identity/fallback';
import { parseRow, reportLoadError } from './parse';

// Public identity (brand, contact channels, location, socials) — `public.site_profile`,
// anon-readable since migration 0019, tenant-fenced by RLS like every public read.
//
// Always returns an Identity: the row mapped to camelCase, or IDENTITY_FALLBACK when the
// database is unconfigured/unreachable or the row is missing/invalid. Every one of those
// is logged, so a site running on the fallback is diagnosable rather than just "fine".

export const SITE_PROFILE_COLUMNS =
  'brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,' +
  'address_locality,address_country,founded_year,socials,accepting_applications,updated_at';

export async function getSiteProfile(): Promise<Identity> {
  if (!supabaseConfigured()) return IDENTITY_FALLBACK;
  try {
    const { data, error } = await anonClient()
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
    };
  } catch (err) {
    reportLoadError('site_profile', err);
    return IDENTITY_FALLBACK;
  }
}
