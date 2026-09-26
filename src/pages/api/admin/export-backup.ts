import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { assertPrivilegedOpAllowed, recordPrivilegedOp } from '@/lib/admin/rateLimit';
import { writeSystemLog } from '@/lib/data/systemLog';
import { AuthorizationError } from '@/lib/authz/errors';
import { BACKUP_TABLES } from '@/lib/admin/backupTables';

// Content backup export — `export.backup` (Admin + Developer). Same seven-step lockdown
// as the CSV export (see leads/export.ts), applied to content rather than leads.
//
// What it dumps, and the tables it must never dump (leads, applications, consent
// records, …), live in src/lib/admin/backupTables.ts — see the rationale there.

export const prerender = false;

const MAX_ROWS_PER_TABLE = 5000;

export const GET = defineAdminRoute({
  cap: 'export.backup',
  handler: async ({ auth, sb }) => {
    await liveRecheck(auth);
    await assertPrivilegedOpAllowed(auth, 'export-backup');
    await recordPrivilegedOp(auth, 'export-backup');

    const attemptLogged = await writeAudit(sb, auth, {
      action: 'export.backup.attempt',
      detail: { tables: BACKUP_TABLES.length },
    });
    if (!attemptLogged) {
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
          'cache-control': 'private, no-store, max-age=0, must-revalidate',
        },
      },
    );
  },
});
