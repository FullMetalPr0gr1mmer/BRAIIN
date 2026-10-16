import { ActivityExportQuerySchema } from '@schemas/audit';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { RateLimitError } from '@/lib/admin/errors';
import { toCsv } from '@/lib/admin/csv';
import { filterParams } from '@/lib/admin/activity';
import {
  ACTIVITY_CSV_HEADER,
  ACTIVITY_EXPORT_CAP,
  activityFilename,
  readActivityRows,
  toActivityRecords,
} from '@/lib/admin/activityExport';
import { assertCap } from '@/lib/authz/matrix';
import { AuthorizationError } from '@/lib/authz/errors';
import { isSameSiteGet } from '@/lib/http/csrf';
import { writeSystemLog } from '@/lib/data/systemLog';

// The activity log as a CSV file (Admin v2 U13): the export lockdown of CLAUDE.md §3 and §7,
// in the lead export's order (src/pages/api/admin/leads/export.ts):
//
//   1. assertCap('export.csv') AND assertCap('audit.view')   Admin + Developer: the file is
//                                       the log, so its readers only, and an export, so its
//                                       exporters only (§5 "Leads / analytics / activity")
//      + this site only                 a link followed from another site's page is refused
//                                       (403) before a slot or a row is spent: the session
//                                       cookie is SameSite=Lax, and Astro's origin check
//                                       covers non-GET methods only (isSameSiteGet)
//   2. liveRecheck()                    a demotion is effective immediately
//   3. rate limit                       3 an hour per person AND 10 per tenant, fail-closed,
//                                       on its own ledger op, so a lead export does not spend
//                                       the activity budget or the other way round
//   4. audit entry #1, ATTEMPT          before a row is read, naming the filters used (their
//                                       names, never their values); FATAL if it cannot be
//                                       written (503): an export nobody could record is not
//                                       made
//   5. the read                         through the caller's own client and RLS (the live
//                                       read of 0054 included), tenant-scoped, keyset-paged,
//                                       capped (ACTIVITY_EXPORT_CAP)
//   6. audit entry #2, OUTCOME          the row count and whether the file was cut; a failure
//                                       after step 4 writes a failed one
//   7. abnormal-volume warning          an export that reaches its cap, to system_logs
//
// The file holds no `detail` values and no hashes: field names only (activityExport.ts).
//
// The page's Export is a plain link, so a refusal a person can act on (the hourly limit, an
// audit that could not be written) sends a browser that navigated here back to the page
// with a notice (303) instead of showing it a JSON body; anything else, and every refusal of
// authority, answers as every admin API does.

export const prerender = false;

const NO_STORE = 'private, no-store, max-age=0, must-revalidate';

/** Did a person follow the link (a top-level navigation), rather than a script fetch it? */
function navigated(request: Request): boolean {
  return request.headers.get('sec-fetch-mode') === 'navigate';
}

/** Back to the log, its filters kept, with the notice the page explains. */
function backToLog(input: Parameters<typeof filterParams>[0], notice: 'limit' | 'unavailable') {
  const params = filterParams(input);
  params.set('export', notice);
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/audit?${params.toString()}`, 'cache-control': NO_STORE },
  });
}

export const GET = defineAdminRoute({
  cap: 'export.csv',
  input: ActivityExportQuerySchema,
  handler: async ({ auth, sb, input, request }) => {
    assertCap(auth, 'audit.view', ['full']);
    // A plain-link GET with side effects (a limiter slot, two audit rows): never on another
    // site's say-so (src/lib/http/csrf.ts isSameSiteGet), and before anything is spent.
    if (!isSameSiteGet(request))
      throw new AuthorizationError('export.csv', 'cross-site export refused');
    await liveRecheck(auth);
    try {
      await claimPrivilegedOp(auth, 'export-activity');
    } catch (err) {
      if (err instanceof RateLimitError && navigated(request)) return backToLog(input, 'limit');
      throw err;
    }

    const attemptLogged = await writeAudit(sb, auth, {
      action: 'export.activity.attempt',
      entityType: 'audit_log',
      detail: { filters: [...filterParams(input).keys()] },
    });
    if (!attemptLogged) {
      if (navigated(request)) return backToLog(input, 'unavailable');
      return json({ ok: false, error: 'audit-unavailable' }, 503);
    }

    let csv: string;
    let rows: number;
    let truncated: boolean;
    try {
      const read = await readActivityRows(sb, auth.tenantId, input, ACTIVITY_EXPORT_CAP);
      const records = await toActivityRecords(sb, auth, read.rows);
      // Built before the outcome row, so an `ok` outcome means the file exists.
      csv = toCsv(ACTIVITY_CSV_HEADER, records);
      rows = records.length;
      truncated = read.truncated;
    } catch (err) {
      await writeAudit(sb, auth, {
        action: 'export.activity.outcome',
        entityType: 'audit_log',
        detail: { status: 'failed', rows: 0 },
      });
      throw err;
    }

    await writeAudit(sb, auth, {
      action: 'export.activity.outcome',
      entityType: 'audit_log',
      detail: { status: 'ok', rows, truncated, cap: ACTIVITY_EXPORT_CAP },
    });

    if (rows >= ACTIVITY_EXPORT_CAP) {
      void writeSystemLog({
        level: 'warn',
        source: 'admin:export-activity',
        message: `activity export reached its cap: ${rows} rows${truncated ? ', more matched' : ''}`,
        detail: {
          actorId: auth.userId,
          role: auth.role,
          rows,
          cap: ACTIVITY_EXPORT_CAP,
          truncated,
        },
      });
    }

    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${activityFilename(new Date(), rows, truncated)}"`,
        'cache-control': NO_STORE,
        'x-content-type-options': 'nosniff',
        'x-export-rows': String(rows),
        'x-export-truncated': String(truncated),
      },
    });
  },
});
