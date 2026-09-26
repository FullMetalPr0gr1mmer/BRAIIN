import { SiteProfileSchema } from '@schemas/siteProfile';
import { singletonRoutes } from '@/lib/admin/singleton';
import { AuthorizationError } from '@/lib/authz/errors';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';

// The public identity (brand, contact channels, location, socials) — `site_profile`,
// migration 0019. §5 "General settings (identity, footer, localization)": Admin +
// Developer (`settings.general`), the same capability as /api/admin/settings, but its own
// table because every visitor reads it and site_settings must stay staff-only.
//
// `acceptingApplications` is narrower than the row — Admin only (it opens the public job
// application intake; applications are Admin-only HR data, UI v2 decision 4). Two server
// layers enforce it, and both must pass (Pillar 1):
//   1. `guardWrite` below, in the Worker, before anything is written;
//   2. the 0019 guard trigger in the database (42501 → 403 in singletonRoutes).
// Both compare against the STORED value rather than asking "was the field sent": the
// settings form always sends the checkbox, and a Developer saving the brand with the
// flag untouched must still succeed.

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
  guardColumns: 'accepting_applications',
  guardWrite: (auth, existing, values) => {
    const next = values['accepting_applications'];
    // No row yet: the INSERT would start from the column default, which is closed.
    const before = existing ? existing['accepting_applications'] === true : false;
    if (next !== undefined && next !== before && auth.role !== 'admin') {
      throw new AuthorizationError(
        'settings.general',
        'only an admin may open or close job applications',
      );
    }
  },
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
