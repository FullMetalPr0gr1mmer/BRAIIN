import { SiteProfileSchema } from '@schemas/siteProfile';
import { singletonRoutes } from '@/lib/admin/singleton';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';

// The public identity (brand, contact channels, location, socials) — `site_profile`,
// migration 0019. §5 "General settings (identity, footer, localization)": Admin +
// Developer (`settings.general`), the same capability as /api/admin/settings, but its own
// table because every visitor reads it and site_settings must stay staff-only.
//
// `acceptingApplications` is narrower than the row — Admin only. assertCap() cannot see
// individual fields, so the database enforces it (the 0019 guard trigger raises 42501,
// which singletonRoutes maps to 403).

export const prerender = false;

const F = IDENTITY_FALLBACK;

export const { GET, PATCH } = singletonRoutes({
  table: 'site_profile',
  entity: 'site_profile',
  readCaps: ['settings.general'],
  readAccess: ['full'],
  writeCap: 'settings.general',
  columns:
    'tenant_id,brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,' +
    'address_locality,address_country,founded_year,socials,accepting_applications,version,updated_at',
  schema: SiteProfileSchema,
  // First save of the singleton is an INSERT; these satisfy its NOT NULL columns with the
  // real identity rather than blanks. Applications stay closed unless an Admin opens them.
  defaults: {
    brand_name: F.brandName,
    legal_name: F.legalName,
    contact_email: F.contactEmail,
    whatsapp_e164: F.whatsappE164,
    whatsapp_display: F.whatsappDisplay,
    location: F.location,
    address_locality: F.addressLocality,
    address_country: F.addressCountry,
    founded_year: F.foundedYear,
    socials: F.socials,
    accepting_applications: false,
  },
  toRow: (input) => {
    const map: Record<string, string> = {
      brandName: 'brand_name',
      legalName: 'legal_name',
      contactEmail: 'contact_email',
      whatsappE164: 'whatsapp_e164',
      whatsappDisplay: 'whatsapp_display',
      location: 'location',
      addressLocality: 'address_locality',
      addressCountry: 'address_country',
      foundedYear: 'founded_year',
      socials: 'socials',
      acceptingApplications: 'accepting_applications',
    };
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(map)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    return out;
  },
});
