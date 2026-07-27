import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { ExportQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { assertPrivilegedOpAllowed, recordPrivilegedOp } from '@/lib/admin/rateLimit';
import { canSeeLeadPii, FULL_LEAD_COLUMNS, SAFE_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { decryptPII } from '@/lib/crypto/pii';
import { writeSystemLog } from '@/lib/data/systemLog';
import { toCsv } from '@/lib/admin/csv';

// Lead CSV export — the full §3 lockdown, in order:
//
//   1. assertCap('export.csv')          Admin + Developer only
//   2. liveRecheck()                    demotion effective immediately
//   3. rate limit                       3/hr/user AND 10/hr/tenant, fail-closed
//   4. audit entry #1 — ATTEMPT         written BEFORE any lead is read, and FATAL if
//                                       it fails: "we could not record that someone
//                                       exported the lead table" is a reason not to
//   5. the dump itself                  tenant-scoped, capped
//   6. audit entry #2 — OUTCOME         with the row count
//   7. abnormal-volume alert
//
// Step 4 is the one that is easy to get backwards. Writing a single audit row after a
// successful export means a dump that crashed, timed out, or was cancelled mid-stream
// leaves no trace — and those are exactly the shapes an exfiltration attempt has.

export const prerender = false;

/** A single request cannot walk the whole table; larger pulls are `export-backup`. */
const MAX_EXPORT_ROWS = 5000;

/** Beyond this, the export is unusual enough to be worth a warning line. */
const ABNORMAL_VOLUME = 1000;

export const GET = defineAdminRoute({
  cap: 'export.csv',
  input: ExportQuerySchema,
  handler: async ({ auth, sb, input }) => {
    await liveRecheck(auth);
    await assertPrivilegedOpAllowed(auth, 'export-csv');
    await recordPrivilegedOp(auth, 'export-csv');

    const withPii = canSeeLeadPii(auth.role);

    const attemptLogged = await writeAudit(sb, auth, {
      action: 'export.csv.attempt',
      entityType: 'lead',
      detail: {
        withPii,
        from: input.from ?? null,
        to: input.to ?? null,
        status: input.status ?? null,
      },
    });
    if (!attemptLogged) {
      const { AuthorizationError } = await import('@/lib/authz/errors');
      throw new AuthorizationError('export.csv', 'audit unavailable — export refused');
    }

    let query = sb
      .from('leads')
      .select(withPii ? FULL_LEAD_COLUMNS : SAFE_LEAD_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false })
      .limit(MAX_EXPORT_ROWS);
    if (input.status) query = query.eq('status', input.status);
    if (input.from) query = query.gte('created_at', input.from);
    if (input.to) query = query.lte('created_at', input.to);

    const { data, error } = await query;
    if (error) {
      await writeAudit(sb, auth, {
        action: 'export.csv.outcome',
        entityType: 'lead',
        detail: { status: 'failed', rows: 0 },
      });
      throw new Error(`export leads: ${error.message}`);
    }

    // See leads/[id].ts: the column list is chosen at runtime from the caller's role,
    // which PostgREST's literal-string typings cannot follow.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];

    const header = withPii
      ? [
          'id',
          'created_at',
          'status',
          'name',
          'email',
          'phone',
          'budget',
          'timeline_band',
          'service_of_interest',
          'locale',
          'message',
          'internal_notes',
        ]
      : ['id', 'created_at', 'status', 'name', 'service_of_interest', 'locale', 'message'];

    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      const base: Record<string, unknown> = {
        id: row['id'],
        created_at: row['created_at'],
        status: row['status'],
        name: row['name'],
        service_of_interest: row['service_of_interest'],
        locale: row['locale'],
        message: row['message'],
      };
      if (withPii) {
        base['email'] = await safeDecrypt(row['email_enc']);
        base['phone'] = await safeDecrypt(row['phone_enc']);
        base['budget'] = await safeDecrypt(row['budget_enc']);
        base['timeline_band'] = row['timeline_band'];
        base['internal_notes'] = row['internal_notes'];
      }
      records.push(base);
    }

    await writeAudit(sb, auth, {
      action: 'export.csv.outcome',
      entityType: 'lead',
      detail: {
        status: 'ok',
        rows: records.length,
        withPii,
        truncated: rows.length >= MAX_EXPORT_ROWS,
      },
    });

    if (records.length >= ABNORMAL_VOLUME) {
      void writeSystemLog({
        level: 'warn',
        source: 'admin:export-csv',
        message: `abnormal lead export volume: ${records.length} rows`,
        detail: { actorId: auth.userId, role: auth.role, rows: records.length },
      });
    }

    const filename = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(toCsv(header, records), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
      },
    });
  },
});

async function safeDecrypt(ciphertext: unknown): Promise<string> {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return '';
  try {
    return await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
  } catch {
    return '';
  }
}
