import { IntegrationsSchema } from '@schemas/admin';
import { singletonRoutes } from '@/lib/admin/singleton';
import { INTEGRATION_COLUMNS, INTEGRATION_DEFAULTS } from '@/lib/admin/integrations/load';

// Third-party integrations (Admin v2 U11, §5 "Integrations"): Admin + SEO in both layers
// (`settings.integrations` here; app.role_manages_integrations plus a RESTRICTIVE live check
// in the database since migration 0105). Typed public identifiers only:
// the GA4 measurement id, the Search Console verification code and the Calendly link, each a
// CHECKed column whose pattern is packages/schemas/integrations.ts. The legacy jsonb boxes
// are gone: U11c's contract dropped them after U11's deploy, and
// tests/lib/integrationsContract.spec.ts holds this route's reads and writes to the columns
// that remain.
//
// Immediate, never staged (P-3): not in the release registry, so `singletonEntry` finds no
// entry and the save is live whatever the release flag says. The audit row names the
// columns saved, never their values (queued, as every singleton's: the values are public and
// no personal data is involved). A Search Console code is public in the home page's head as
// soon as it is saved; nothing caches Tier A today, and the purge seam (R7) owes
// `site:identity` a purge on this save.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes({
  table: 'site_integrations',
  entity: 'site_integrations',
  readCaps: ['settings.integrations'],
  readAccess: ['full'],
  writeCap: 'settings.integrations',
  columns: INTEGRATION_COLUMNS,
  schema: IntegrationsSchema,
  defaults: INTEGRATION_DEFAULTS,
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    if (input['ga4MeasurementId'] !== undefined) {
      out['ga4_measurement_id'] = input['ga4MeasurementId'];
    }
    if (input['searchConsoleToken'] !== undefined) {
      out['search_console_token'] = input['searchConsoleToken'];
    }
    if (input['calendlyUrl'] !== undefined) out['calendly_url'] = input['calendlyUrl'];
    return out;
  },
});
