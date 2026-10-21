import { SiteSettingsSchema } from '@schemas/settings';
import type { SingletonConfig } from '@/lib/admin/singleton';
import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';

// The technical settings row, `site_settings` (Admin + Developer, `settings.general`): the
// studio's time zone (Admin v2 U9, 0098) and the retention horizons. Integrations live
// elsewhere (site_integrations, Admin + SEO), and maintenance has its own endpoint (the same
// row, its own audit actions). Moved here from src/pages/api/admin/settings/index.ts (U9, the
// R2 pattern: configs in singletons/, routes one line).
//
// `identity` (`{title, default_locale}`) left the form and the schema in U9: nothing has read
// it since 0048. The column stays until a contract slice drops it.

export const siteSettingsSingleton: SingletonConfig = {
  table: 'site_settings',
  entity: 'site_settings',
  readCaps: ['settings.general'],
  readAccess: ['full'],
  writeCap: 'settings.general',
  columns: 'tenant_id,timezone,retention,version,updated_at',
  schema: SiteSettingsSchema,
  defaults: {
    timezone: DEFAULT_TIME_ZONE,
    maintenance: { active: false, allowlist: [] },
    // RAW_TELEMETRY_RETENTION = 90 days, the single named constant of CLAUDE.md
    // Pillar 4. Mirrored from migration 0001's column default; the Zod schema caps it
    // at 90 so this can only ever be shortened, never extended past the PDPL promise.
    retention: { raw_telemetry_days: 90, leads_months: 24, spam_days: 30 },
  },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    if (input['timezone'] !== undefined) out['timezone'] = input['timezone'];
    if (input['retention'] !== undefined) out['retention'] = input['retention'];
    return out;
  },
  constraintFields: {
    site_settings_timezone_closed: {
      field: 'timezone',
      message: 'Choose one of the listed time zones.',
    },
  },
};
