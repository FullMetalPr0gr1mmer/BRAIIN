import { SiteSettingsSchema } from '@schemas/admin';
import { singletonRoutes } from '@/lib/admin/singleton';

// General settings — identity, footer, localization, retention horizons.
// Admin + Developer (`settings.general`). Integrations deliberately live elsewhere
// (site_integrations, Admin + SEO) and maintenance has its own endpoint so the two
// capabilities stay separately auditable.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes({
  table: 'site_settings',
  entity: 'site_settings',
  readCaps: ['settings.general'],
  readAccess: ['full'],
  writeCap: 'settings.general',
  columns: 'tenant_id,identity,maintenance,retention,version,updated_at',
  schema: SiteSettingsSchema,
  defaults: {
    identity: {},
    maintenance: { active: false, allowlist: [] },
    // RAW_TELEMETRY_RETENTION = 90 days, the single named constant of CLAUDE.md
    // Pillar 4. Mirrored from migration 0001's column default; the Zod schema caps it
    // at 90 so this can only ever be shortened, never extended past the PDPL promise.
    retention: { raw_telemetry_days: 90, leads_months: 24, spam_days: 30 },
  },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    if (input['identity'] !== undefined) out['identity'] = input['identity'];
    if (input['retention'] !== undefined) out['retention'] = input['retention'];
    return out;
  },
});
