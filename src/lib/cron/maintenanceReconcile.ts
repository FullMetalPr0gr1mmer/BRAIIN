import { env as workerEnv } from 'cloudflare:workers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '@/lib/supabase/server';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import type { CronJob } from './jobs';
import { readMaintenance, type MaintenanceSnapshot } from '@schemas/maintenance';
import { writeSystemLog } from '@/lib/data/systemLog';
import {
  putMaintenanceState,
  readMaintenanceSnapshot,
} from '@/lib/http/maintenance';
import { readContact } from '@/lib/maintenance/contact';

// The maintenance reconcile (Admin v2 U9b, decision D12), a job of the 10-minute schedule
// (src/lib/cron/schedules.ts; the plan's one dispatcher, §5.7). The edge ends maintenance at
// the "Back on" instant with no write (src/lib/http/maintenance.ts); this job then makes the
// row say so, and keeps the edge's value in step with the row, in ONE direction only:
//
//   - the row's switch is on and "Back on" has come: the row is turned off with a version
//     check (a race with an editor's save is skipped and logged, the next run retries), the
//     edge value follows, and `maintenance.auto_disable` is audited (no actor: the database
//     stamps the time, H10);
//   - the edge says on and the row says off: the edge is healed to the row (off);
//   - the row says on and the edge says off, or cannot be read: NEVER switched on by a job.
//     Taking the site down is a person's decision; it is logged as an error, so Site health
//     shows it, and the admin's next save puts it right;
//   - while the switch is on, the contact buttons (a snapshot of site_profile) are refreshed
//     when the identity changed.
//
// The launch tenant only: the KV key `site:maintenance` is the deployment's, as the
// visibility snapshot's is. Counts and states only go to system_logs.

export interface ReconcileResult {
  /** What the run did: nothing, ended maintenance, healed the edge, refreshed the buttons. */
  outcome: 'none' | 'ended' | 'ended-race' | 'healed' | 'contact' | 'edge-off-while-on';
  kvSynced: boolean | null;
}

const sameContact = (a: MaintenanceSnapshot['contact'], b: MaintenanceSnapshot['contact']) =>
  JSON.stringify(a) === JSON.stringify(b);

export async function reconcileMaintenance(
  sb: SupabaseClient,
  env: { SESSION?: KVNamespace },
  tenantId: string,
  now: number = Date.now(),
): Promise<ReconcileResult> {
  const { data, error } = await sb
    .from('site_settings')
    .select('maintenance,version')
    .eq('tenant_id', tenantId)
    .maybeSingle<{ maintenance: unknown; version: number }>();
  if (error) throw new Error(`maintenance reconcile: read: ${error.code ?? 'no code'}`);
  const row = readMaintenance(data?.maintenance ?? null);
  const edge = await readMaintenanceSnapshot(env);

  // 1. "Back on" has come: the row says off from that instant.
  if (data && row.active && row.untilAt && Date.parse(row.untilAt) <= now) {
    const next: MaintenanceSnapshot = {
      ...row,
      active: false,
      until: null,
      untilAt: null,
      changedAt: row.untilAt,
    };
    const { data: updated, error: writeError } = await sb
      .from('site_settings')
      .update({ maintenance: next })
      .eq('tenant_id', tenantId)
      .eq('version', data.version)
      .select('version')
      .maybeSingle();
    if (writeError) throw new Error(`maintenance reconcile: write: ${writeError.code ?? 'no code'}`);
    if (!updated) {
      await writeSystemLog({
        level: 'warn',
        source: 'cron:maintenance-reconcile',
        message: 'maintenance ended by its date; an editor saved at the same time, so the next run settles it',
      });
      return { outcome: 'ended-race', kvSynced: null };
    }
    const kvSynced = await putMaintenanceState(env, next);
    const { error: auditError } = await sb.from('audit_log').insert({
      tenant_id: tenantId,
      actor_id: null,
      actor_role: null,
      action: 'maintenance.auto_disable',
      entity_type: 'site_settings',
      entity_id: tenantId,
      detail: { until: row.until, kvSynced },
    });
    await writeSystemLog({
      level: auditError ? 'error' : 'info',
      source: 'cron:maintenance-reconcile',
      message: auditError
        ? 'maintenance ended by its date; the audit row could not be written'
        : 'maintenance ended by its date',
      detail: { kvSynced, audited: !auditError },
    });
    return { outcome: 'ended', kvSynced };
  }

  // 2. The edge says on, the row says off: heal toward off.
  if (!row.active && edge?.active) {
    const kvSynced = await putMaintenanceState(env, row);
    await writeSystemLog({
      level: kvSynced ? 'info' : 'error',
      source: 'cron:maintenance-reconcile',
      message: kvSynced
        ? 'the edge said maintenance was on while the settings said off; healed to off'
        : 'the edge says maintenance is on while the settings say off, and could not be healed',
    });
    return { outcome: 'healed', kvSynced };
  }

  // 3. The row says on, the edge does not: never switched on by a job.
  if (row.active && !edge?.active) {
    await writeSystemLog({
      level: 'error',
      source: 'cron:maintenance-reconcile',
      message:
        'maintenance is on in the settings but not at the edge; save it again in the admin to apply it',
    });
    return { outcome: 'edge-off-while-on', kvSynced: false };
  }

  // 4. On, both agree: the contact buttons follow the identity.
  if (row.active && edge?.active) {
    const contact = await readContact(sb, tenantId);
    if (contact && !sameContact(contact, edge.contact)) {
      const kvSynced = await putMaintenanceState(env, { ...edge, contact });
      return { outcome: 'contact', kvSynced };
    }
  }
  return { outcome: 'none', kvSynced: null };
}

/** The job, in the 10-minute schedule after the health probes. */
export const MAINTENANCE_RECONCILE_JOB: CronJob = {
  name: 'maintenance-reconcile',
  label: 'maintenance reconcile',
  // The launch tenant (1), the settings row (1), the edge's value (1), the row's update (1),
  // the edge's write (1), the audit row (1), its line (2): 8 at worst. (Refreshing the
  // buttons instead: the identity read and the edge's write, 2, within the same 8.)
  budget: 1 + 1 + 1 + 1 + 1 + 1 + 2,
  run: async () => {
    const tenantId = await resolveLaunchTenantId();
    if (!tenantId) throw new Error('maintenance reconcile: the launch tenant could not be read');
    await reconcileMaintenance(serviceClient(), workerEnv, tenantId);
  },
};
