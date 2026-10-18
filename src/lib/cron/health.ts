import { serviceClient } from '@/lib/supabase/server';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { runHealthProbes } from '@/lib/health/probes';
import type { CronJob } from './jobs';

// The Worker's health schedule (Admin v2 G2, `*/10 * * * *`, src/lib/cron/schedules.ts): the
// uptime monitor's reading every 10 minutes, the certificate with it, and the domain's
// registration record about once a day (src/lib/health/probes.ts). Its own trigger, not the
// daily cron, whose jobs already declare 49 of the Free plan's 50 subrequests: a trigger is
// its own invocation with its own 50.
//
// Launch tenant only (decision D8): the monitor's key and its monitors are deployment-wide,
// so another tenant's site health says "Not set up".

export const HEALTH_JOBS: readonly CronJob[] = [
  {
    name: 'health-probes',
    label: 'health probes',
    // The launch tenant (1); the tenant's domain with its three rows (1); the monitor (2: one
    // retry on a network error or a 5xx; a POST never follows a redirect); the IANA
    // bootstrap when its 30-day entry is stale (2: a retry or one redirect); the registry's
    // record (2); the upsert (1); one line when a read failed (2): 11 at worst.
    budget: 1 + 1 + 2 + 2 + 2 + 1 + 2,
    run: probeLaunchTenant,
  },
];

async function probeLaunchTenant(): Promise<void> {
  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) throw new Error('health probes: the launch tenant could not be read');
  await runHealthProbes(serviceClient(), tenantId, { source: 'cron:health-probes' });
}
