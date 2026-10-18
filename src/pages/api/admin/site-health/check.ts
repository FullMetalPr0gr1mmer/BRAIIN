import { defineAdminRoute, json } from '@/lib/admin/route';
import { RateLimitError } from '@/lib/admin/errors';
import { HEALTH_CHECK_LIMITS, claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { reportOf } from '@/lib/admin/health/probes';
import { probeJson } from '@/lib/admin/health/probeJson';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { runHealthProbes } from '@/lib/health/probes';
import { serviceClient } from '@/lib/supabase/server';

// Check now (Admin v2 G2): read the uptime monitor and the domain's registration record at
// once, instead of waiting for the 10-minute health schedule. `siteHealth.view` (Admin,
// Developer), the screen's own capability.
//
//   launch tenant   The monitor's key and its monitors are deployment-wide (decision D8), so
//                   only the launch tenant has readings: any other tenant gets a 409 BEFORE
//                   any tenant-scoped query (tests/authz/endpoints.spec.ts).
//   rate limit      HEALTH_CHECK_LIMITS (6 an hour per person, 12 per tenant) on the
//                   privileged-op ledger, claimed before the work and failing closed: a 429
//                   with Retry-After. Each check is up to six outbound requests, and the
//                   monitor's own API allows 10 a minute on its free plan.
//   writes          the service role, as the cron does (health_probes has no staff write
//                   path); the database stamps the rows. No audit row (decision D7): it
//                   changes no content or access and reads public facts; the ledger records
//                   who asked and when, and a failed read goes to system_logs.
// The answer is the GET twin's `uptime`, `domain` and `certificate` keys, plus `checkedAt`
// and which reads failed (their kinds only).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'siteHealth.view',
  handler: async ({ auth }) => {
    const launch = await resolveLaunchTenantId();
    if (!launch || auth.tenantId !== launch) {
      return json(
        { ok: false, error: 'single-site', detail: 'Uptime is set up for one site only' },
        409,
      );
    }
    try {
      await claimPrivilegedOp(auth, 'health.check', HEALTH_CHECK_LIMITS);
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;
      const response = json({ ok: false, error: 'rate-limit', scope: err.scope }, 429);
      response.headers.set('retry-after', String(HEALTH_CHECK_LIMITS.windowMinutes * 60));
      return response;
    }
    const now = new Date();
    const run = await runHealthProbes(serviceClient(), auth.tenantId, {
      force: true,
      now,
      source: 'admin:health',
    });
    const report = reportOf(run.rows);
    return {
      checkedAt: now.toISOString(),
      uptime: probeJson(report.uptime),
      domain: probeJson(report.domain),
      certificate: probeJson(report.certificate),
      failed: run.failed.map((f) => f.kind),
    };
  },
});
