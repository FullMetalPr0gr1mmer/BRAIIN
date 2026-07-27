import { env } from 'cloudflare:workers';
import { MaintenanceSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { OptimisticLockError } from '@/lib/admin/errors';
import { clientIp, putMaintenanceState } from '@/lib/http/maintenance';

// Maintenance mode + IP allowlist (`maintenance.manage` — Admin + Developer).
//
// Two writes, in this order, and the order is the whole design:
//   1. `site_settings.maintenance` — durable, audited, RLS-gated source of truth
//   2. the KV snapshot the middleware pre-cache check actually reads
//
// If KV fails we report `kvSynced: false` rather than pretending success, because the
// operator's next action depends on it: the row says "maintenance on", the edge says
// "off", and the site is still serving. Silently returning 200 there is how a
// maintenance window turns into a deploy over live traffic.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'maintenance.manage',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb
      .from('site_settings')
      .select('maintenance,version')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle();
    if (error) throw new Error(`read maintenance: ${error.message}`);
    return data ?? { maintenance: { active: false, allowlist: [] }, version: 0 };
  },
});

export const PATCH = defineAdminRoute({
  cap: 'maintenance.manage',
  input: MaintenanceSchema,
  handler: async ({ auth, sb, input, audit, request }) => {
    const state = { active: input.active, allowlist: input.allowlist };

    const { data: existing, error: readError } = await sb
      .from('site_settings')
      .select('version')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<{ version: number }>();
    if (readError) throw new Error(`read settings: ${readError.message}`);

    if (!existing) {
      if (input.version !== 0 && input.version !== 1)
        throw new OptimisticLockError('site_settings');
      const { error } = await sb
        .from('site_settings')
        .insert({ tenant_id: auth.tenantId, maintenance: state });
      if (error) throw new Error(`create settings: ${error.message}`);
    } else {
      if (existing.version !== input.version) throw new OptimisticLockError('site_settings');
      const { data, error } = await sb
        .from('site_settings')
        .update({ maintenance: state })
        .eq('tenant_id', auth.tenantId)
        .eq('version', input.version)
        .select('version')
        .maybeSingle();
      if (error) throw new Error(`update settings: ${error.message}`);
      if (!data) throw new OptimisticLockError('site_settings');
    }

    const kvSynced = await putMaintenanceState(env, state);

    // Turning maintenance ON or OFF is a sitewide availability change; the operator's
    // own IP is recorded so "who took the site down at 03:00" has an answer.
    audit({
      action: state.active ? 'maintenance.enable' : 'maintenance.disable',
      entityType: 'site_settings',
      entityId: auth.tenantId,
      detail: { allowlistSize: state.allowlist.length, kvSynced, ip: clientIp(request) ?? null },
    });

    return { ...state, kvSynced };
  },
});
