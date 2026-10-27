import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { RateLimitError } from '@/lib/admin/errors';
import { writeSystemLog } from '@/lib/data/systemLog';
import { AuthorizationError } from '@/lib/authz/errors';
import { BACKUP_TABLES } from '@/lib/admin/backupTables';
import { isSameSiteGet } from '@/lib/http/csrf';

// Content backup export — `export.backup` (Admin + Developer). Same seven-step lockdown
// as the CSV export (see leads/export.ts), applied to content rather than leads.
//
// What it dumps, and the tables it must never dump (leads, applications, consent
// records, …), live in src/lib/admin/backupTables.ts — see the rationale there.
//
// Admin v2 R13: Backups & versions' "Download content" is a plain link to this route, so, as
// the activity log's export (U13): a link followed from another site's page is refused (403)
// before a slot or a row is spent (`isSameSiteGet`: the session cookie is SameSite=Lax, and
// Astro's origin check covers non-GET methods only), and a refusal a person can act on (the
// hourly limit, an audit that could not be written) sends a browser that navigated here back
// to the page with a notice (303 to /admin/backups?export=limit|unavailable) instead of a JSON
// body. A script's request is answered as every admin API answers, as before.

export const prerender = false;

const NO_STORE = 'private, no-store, max-age=0, must-revalidate';

/** Did a person follow the link (a top-level navigation), rather than a script fetch it? */
function navigated(request: Request): boolean {
  return request.headers.get('sec-fetch-mode') === 'navigate';
}

/** Back to Backups & versions, with the notice the page explains. */
function backToBackups(notice: 'limit' | 'unavailable'): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/backups?export=${notice}`, 'cache-control': NO_STORE },
  });
}

const MAX_ROWS_PER_TABLE = 5000;

export const GET = defineAdminRoute({
  cap: 'export.backup',
  handler: async ({ auth, sb, request }) => {
    // A plain-link GET with side effects (a limiter slot, two audit rows): never on another
    // site's say-so (src/lib/http/csrf.ts isSameSiteGet), and before anything is spent.
    if (!isSameSiteGet(request)) {
      throw new AuthorizationError('export.backup', 'cross-site export refused');
    }
    await liveRecheck(auth);
    try {
      await claimPrivilegedOp(auth, 'export-backup');
    } catch (err) {
      // The ledger itself down (`:unavailable`) is no hourly limit: say it could not run.
      if (err instanceof RateLimitError && navigated(request)) {
        return backToBackups(err.scope.endsWith(':unavailable') ? 'unavailable' : 'limit');
      }
      throw err;
    }

    const attemptLogged = await writeAudit(sb, auth, {
      action: 'export.backup.attempt',
      detail: { tables: BACKUP_TABLES.length },
    });
    if (!attemptLogged) {
      if (navigated(request)) return backToBackups('unavailable');
      throw new AuthorizationError('export.backup', 'audit unavailable — export refused');
    }

    const payload: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    const failed: string[] = [];

    for (const { table, columns } of BACKUP_TABLES) {
      // Every read goes through the RLS-bound client and repeats the tenant predicate.
      // A backup is the operation most likely to be written with the service-role client
      // "because it needs everything" — which is how a backup becomes a cross-tenant
      // read in a tenant-ready schema.
      const { data, error } = await sb
        .from(table)
        .select(columns)
        .eq('tenant_id', auth.tenantId)
        .limit(MAX_ROWS_PER_TABLE);
      if (error) {
        failed.push(table);
        continue;
      }
      payload[table] = data ?? [];
      counts[table] = data?.length ?? 0;
    }

    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

    await writeAudit(sb, auth, {
      action: 'export.backup.outcome',
      detail: { status: failed.length ? 'partial' : 'ok', rows: totalRows, counts, failed },
    });

    if (failed.length > 0) {
      void writeSystemLog({
        level: 'warn',
        source: 'admin:export-backup',
        message: `backup export skipped ${failed.length} table(s)`,
        detail: { failed, actorId: auth.userId },
      });
    }

    const filename = `braiin-content-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(
      JSON.stringify(
        { exportedAt: new Date().toISOString(), tenantId: auth.tenantId, counts, data: payload },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': NO_STORE,
        },
      },
    );
  },
});
