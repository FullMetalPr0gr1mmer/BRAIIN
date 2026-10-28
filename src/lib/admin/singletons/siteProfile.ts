import { env } from 'cloudflare:workers';
import { SiteProfileSchema } from '@schemas/siteProfile';
import { contactFromRow } from '@/lib/maintenance/contact';
import { refreshMaintenanceContact } from '@/lib/maintenance/refresh';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { AuthorizationError } from '@/lib/authz/errors';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { fieldsOf } from '@/lib/admin/resources/shared';

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
//
// Moved here from src/pages/api/admin/site-profile.ts unchanged (Admin v2 R2) so the
// release registry can bind it without importing a route.

const F = IDENTITY_FALLBACK;

/** Payload key → column: what `toRow` copies, and (through `fieldsOf`) its `fields`. */
const SITE_PROFILE_KEYS = {
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
  // Admin v2 U9 (0102)
  tagline: 'tagline',
  phoneE164: 'phone_e164',
  phoneDisplay: 'phone_display',
  mapUrl: 'map_url',
  faviconMediaId: 'favicon_media_id',
  appIconMediaId: 'app_icon_media_id',
  footerCopyright: 'footer_copyright',
  footerStyle: 'footer_style',
  footerShowEmail: 'footer_show_email',
  footerShowSocial: 'footer_show_social',
};

/** What a refused icon says (0102's trigger, and its foreign key for another tenant's id). */
export const ICON_REFUSED =
  'Choose a square picture from the media library, at least 512 pixels wide.';
const DISPLAY_NEEDS_NUMBER = 'Add the number this displays, or clear it.';

export const siteProfileSingleton: SingletonConfig = {
  table: 'site_profile',
  entity: 'site_profile',
  readCaps: ['settings.general'],
  readAccess: ['full'],
  writeCap: 'settings.general',
  columns:
    'tenant_id,brand_name,legal_name,contact_email,whatsapp_e164,whatsapp_display,location,' +
    'address_locality,address_country,founded_year,socials,accepting_applications,' +
    'tagline,phone_e164,phone_display,map_url,favicon_media_id,app_icon_media_id,' +
    'footer_copyright,footer_style,footer_show_email,footer_show_social,version,updated_at',
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
    // The column defaults (0102): today's footer, no tagline, phone, map or icons.
    tagline: null,
    phone_e164: null,
    phone_display: null,
    map_url: null,
    favicon_media_id: null,
    app_icon_media_id: null,
    footer_copyright: null,
    footer_style: 'light',
    footer_show_email: true,
    footer_show_social: false,
  },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(SITE_PROFILE_KEYS)) {
      if (input[key] !== undefined) out[column] = input[key];
    }
    return out;
  },
  fields: fieldsOf(SITE_PROFILE_KEYS),
  // Admin v2 U9: a refused icon or phone pair is a 422 on its field, not a generic one.
  foreignKeys: {
    site_profile_favicon_fk: { field: 'faviconMediaId', message: ICON_REFUSED },
    site_profile_app_icon_fk: { field: 'appIconMediaId', message: ICON_REFUSED },
  },
  constraintFields: {
    site_profile_favicon_square: { field: 'faviconMediaId', message: ICON_REFUSED },
    site_profile_app_icon_square: { field: 'appIconMediaId', message: ICON_REFUSED },
    site_profile_phone_display_needs_number: {
      field: 'phoneDisplay',
      message: DISPLAY_NEEDS_NUMBER,
    },
    site_profile_whatsapp_display_needs_number: {
      field: 'whatsappDisplay',
      message: DISPLAY_NEEDS_NUMBER,
    },
  },
  // Maintenance v2 (U9b): while the maintenance page is up, its contact buttons (a snapshot
  // of this row at the last maintenance save) follow an identity save at once, at the edge.
  // The value put is built from the maintenance ROW (site_settings, which settings.general
  // holders read), never from KV's own copy: a KV read can be up to a minute stale in this
  // location, and re-putting it would bring back a bypass, an address or even the switch a
  // colleague has just changed. KV only says whether the edge has maintenance on (when it
  // does not, nothing is read or written: an identity save never switches the site on), and
  // the row must say on too. Best effort: a failure is in the audit detail and the cron's
  // reconcile heals it within ten minutes. With releases on, a release that changes these
  // columns does the same after it goes live (src/lib/release/afterEffects.ts, R14-prep); both
  // through src/lib/maintenance/refresh.ts.
  afterWrite: async ({ auth, sb, row }) => {
    const refreshed = await refreshMaintenanceContact({
      sb,
      tenantId: auth.tenantId,
      env,
      contact: contactFromRow(row),
    });
    return refreshed === 'not-needed' ? undefined : { maintenanceContact: refreshed };
  },
  // The job-application intake switch is never part of a release (Admin v2 P-3; 0038's
  // exempt_columns): with releases on it gets its own endpoint (R3). The legacy PATCH above
  // still writes it while releases are off.
  immediateColumns: ['accepting_applications'],
};
