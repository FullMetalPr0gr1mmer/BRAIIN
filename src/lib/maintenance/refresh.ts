import type { SupabaseClient } from '@supabase/supabase-js';
import { readMaintenance, type MaintenanceContact } from '@schemas/maintenance';
import { edgeValueOf, putMaintenanceState, readMaintenanceSnapshot } from '@/lib/http/maintenance';
import { readContact } from './contact';

// The maintenance page's contact buttons follow the identity at the edge (Admin v2 U9b; R7's
// hand-off, built in R14-prep). SERVER ONLY. Two callers:
//   - an identity save that went live (src/lib/admin/singletons/siteProfile.ts `afterWrite`),
//     with the row it saved;
//   - a release that changed the identity's contact columns (src/lib/release/afterEffects.ts),
//     with the identity as the release left it (its after-image), or none when the release's
//     items are not known (read then).
//
// While the edge says maintenance is on and the settings row says so too, the edge's value is
// put again from the ROW (site_settings, every setting: the bypass, the allowlist, the words,
// "Back on") with the buttons from the identity. Never from KV's own copy: a KV read can be up to
// a minute stale in this location, and re-putting it would bring back a bypass, an address or
// even the switch a colleague has just changed. KV only says whether the edge has maintenance on
// (when it does not, nothing is read or written: an identity change never switches the site on),
// and the row must say on too. Best effort: the cron's 10-minute reconcile heals a miss
// (src/lib/cron/maintenanceReconcile.ts).
//
// Subrequests: the edge's value (1); while on, the settings row (1), the identity when not
// handed over (1), and the put (1).

/** What a refresh did: nothing to do (maintenance off), the buttons put, or not put. */
export type ContactRefresh = 'not-needed' | 'refreshed' | 'not-refreshed';

export async function refreshMaintenanceContact(args: {
  /** A client that reads the tenant's settings row: the person's own, or the system's. */
  sb: SupabaseClient;
  tenantId: string;
  env: { SESSION?: KVNamespace };
  /** The identity's buttons, when the caller holds the row; read otherwise. */
  contact?: MaintenanceContact | undefined;
}): Promise<ContactRefresh> {
  const { sb, tenantId, env } = args;
  const edge = await readMaintenanceSnapshot(env);
  if (!edge?.active) return 'not-needed';
  const { data, error } = await sb
    .from('site_settings')
    .select('maintenance')
    .eq('tenant_id', tenantId)
    .maybeSingle<{ maintenance: unknown }>();
  if (error) return 'not-refreshed';
  const stored = readMaintenance(data?.maintenance ?? null);
  if (!stored.active) return 'not-needed';
  const contact = args.contact ?? (await readContact(sb, tenantId));
  if (!contact) return 'not-refreshed';
  return (await putMaintenanceState(env, edgeValueOf(stored, contact)))
    ? 'refreshed'
    : 'not-refreshed';
}
