import { IntegrationsSchema } from '@schemas/admin';
import { singletonRoutes } from '@/lib/admin/singleton';

// Third-party integration config — Admin + SEO (`settings.integrations`). Read is
// staff-wide because the consent banner and analytics dashboards need to know whether
// GA4 is configured; write is the narrow pair.

export const prerender = false;

export const { GET, PATCH } = singletonRoutes({
  table: 'site_integrations',
  entity: 'site_integrations',
  readCaps: ['settings.integrations'],
  readAccess: ['full'],
  writeCap: 'settings.integrations',
  columns: 'tenant_id,ga4,search_console,calendly,recaptcha,version,updated_at',
  schema: IntegrationsSchema,
  defaults: { ga4: {}, search_console: {}, calendly: {}, recaptcha: {} },
  toRow: (input) => {
    const out: Record<string, unknown> = {};
    if (input['ga4'] !== undefined) out['ga4'] = input['ga4'];
    if (input['searchConsole'] !== undefined) out['search_console'] = input['searchConsole'];
    if (input['calendly'] !== undefined) out['calendly'] = input['calendly'];
    if (input['recaptcha'] !== undefined) out['recaptcha'] = input['recaptcha'];
    return out;
  },
});
