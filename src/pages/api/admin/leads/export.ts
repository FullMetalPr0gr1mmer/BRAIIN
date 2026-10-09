import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadExportQuerySchema, type LeadExportQuery } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { canSeeLeadPii, GATED_LEAD_COLUMNS, SAFE_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { AuthorizationError } from '@/lib/authz/errors';
import { decryptPII } from '@/lib/crypto/pii';
import { budgetBandLabel } from '@schemas/lead';
import { writeSystemLog } from '@/lib/data/systemLog';
import { toCsv } from '@/lib/admin/csv';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { serviceClient } from '@/lib/supabase/server';
import {
  afterFilter,
  exportsSpam,
  MAX_EXPORT_ROWS,
  readPaged,
  type ExportPage,
} from '@/lib/crm/exportRead';

// Lead CSV export — the full §3 lockdown, in order:
//
//   1. assertCap('export.csv')          Admin + Developer only
//   2. liveRecheck()                    demotion effective immediately
//   3. rate limit                       3/hr/user AND 10/hr/tenant, fail-closed
//   4. audit entry #1 — ATTEMPT         written BEFORE any lead is read, and FATAL if
//                                       it fails: "we could not record that someone
//                                       exported the lead table" is a reason not to
//   5. the dump itself                  tenant-scoped, capped; with PII it reads as the
//                                       service role, because staff tokens cannot read
//                                       the gated columns at all (0033)
//   6. audit entry #2 — OUTCOME         with the row count
//   7. abnormal-volume alert
//
// Step 4 is the one that is easy to get backwards. Writing a single audit row after a
// successful export means a dump that crashed, timed out, or was cancelled mid-stream
// leaves no trace — and those are exactly the shapes an exfiltration attempt has.
//
// Since Admin v2 C3 the export follows the list's filters a link may carry (stage, spam,
// a date range; never the search, which would sit in the URL), with the list's defaults (no
// spam unless asked, `to` exclusive), and carries the pipeline: the lead's number, stage,
// spam flag, assignee, value, tags, score, source and channel. Note BODIES are not exported,
// only how many notes a lead has: bulk free text about named people is the riskiest thing a
// file can hold (crm.md §9). The read is keyset-paged (src/lib/crm/exportRead.ts), so the
// cap really is the cap: one unpaged read was cut at 1,000 by the API's row limit without a
// word, and an export that stops short says so (`truncated`).

export const prerender = false;

/** Beyond this, the export is unusual enough to be worth a warning line. */
const ABNORMAL_VOLUME = 1000;

/** The pipeline's columns the export carries (all readable by staff since 0034 to 0041). */
const PIPELINE_COLUMNS =
  'lead_number,stage_id,is_spam,assigned_to,value_sar,tags,score,source,channel';

/** The gated columns a PII export decrypts or carries: never the notes, never the address. */
const NOT_EXPORTED = new Set(['internal_notes', 'ip_inet']);
const PII_COLUMNS = GATED_LEAD_COLUMNS.split(',')
  .filter((column) => !NOT_EXPORTED.has(column))
  .join(',');

const SAFE_HEADER = [
  'id',
  'lead_number',
  'created_at',
  'status',
  'stage',
  'spam',
  'name',
  'company',
  'service_of_interest',
  'service_label',
  'service_label_ar',
  'discipline_of_interest',
  'discipline_label',
  'discipline_label_ar',
  'locale',
  'message',
  'assignee',
  'value_sar',
  'tags',
  'score',
  'source',
  'channel',
];

const PII_HEADER = [
  ...SAFE_HEADER.slice(0, SAFE_HEADER.indexOf('company') + 1),
  'email',
  'phone',
  'budget',
  'timeline',
  'timeline_band',
  ...SAFE_HEADER.slice(SAFE_HEADER.indexOf('company') + 1),
  'notes_count',
];

/**
 * One page of the leads matching the filters, newest first (src/lib/crm/exportRead.ts pages
 * through them). `tenantId` is the session's: for a PII export the reader is the service role,
 * which bypasses RLS, so this filter is the tenant fence (tests/lib/leadExportTenant.spec.ts).
 */
function leadPage(
  reader: SupabaseClient,
  tenantId: string,
  columns: string,
  input: LeadExportQuery,
): ExportPage {
  const spam = exportsSpam(input);
  return async (limit, after) => {
    let query = reader
      .from('leads')
      .select(columns)
      .eq('tenant_id', tenantId)
      .eq('is_spam', spam)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit);
    if (input.status) query = query.eq('status', input.status);
    if (input.stage) query = query.eq('stage_id', input.stage);
    if (input.from) query = query.gte('created_at', input.from);
    if (input.to) query = query.lt('created_at', input.to);
    if (after) query = query.or(afterFilter(after));
    const { data, error } = await query;
    if (error) throw new Error(`export leads: ${error.code ?? 'no code'}`);
    // See leads/[id].ts: the column list is chosen at runtime, which PostgREST's
    // literal-string typings cannot follow.
    return (data ?? []) as unknown as Record<string, unknown>[];
  };
}

export const GET = defineAdminRoute({
  cap: 'export.csv',
  input: LeadExportQuerySchema,
  handler: async ({ auth, sb, input }) => {
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'export-csv');

    const withPii = canSeeLeadPii(auth.role);

    const attemptLogged = await writeAudit(sb, auth, {
      action: 'export.csv.attempt',
      entityType: 'lead',
      detail: {
        withPii,
        from: input.from ?? null,
        to: input.to ?? null,
        status: input.status ?? null,
        stage: input.stage ?? null,
        spam: input.spam ?? null,
      },
    });
    if (!attemptLogged) {
      throw new AuthorizationError('export.csv', 'audit unavailable, export refused');
    }

    let records: Record<string, unknown>[];
    let truncated: boolean;
    try {
      // The gated columns are refused to the caller's own client (0033), so a PII export
      // reads as the service role: only after steps 1-4, and scoped to the caller's tenant
      // here, since the service role bypasses RLS. Without PII it stays on the caller's
      // client and RLS.
      const svc = withPii ? serviceClient() : null;
      const reader = svc ?? sb;
      const columns = `${SAFE_LEAD_COLUMNS},${PIPELINE_COLUMNS}${withPii ? `,${PII_COLUMNS}` : ''}`;
      const read = await readPaged(
        leadPage(reader, auth.tenantId, columns, input),
        MAX_EXPORT_ROWS,
      );
      const rows = read.rows;
      truncated = read.truncated;
      records = await toRecords(sb, svc, auth.tenantId, rows);
    } catch (err) {
      await writeAudit(sb, auth, {
        action: 'export.csv.outcome',
        entityType: 'lead',
        detail: { status: 'failed', rows: 0 },
      });
      throw err;
    }

    await writeAudit(sb, auth, {
      action: 'export.csv.outcome',
      entityType: 'lead',
      detail: { status: 'ok', rows: records.length, withPii, truncated },
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
    return new Response(toCsv(withPii ? PII_HEADER : SAFE_HEADER, records), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
      },
    });
  },
});

/**
 * The rows as CSV records: stage labels and assignee names resolved once for the batch
 * (the caller's own client: lead workers read both), interest labels likewise, and, for a
 * PII export (`svc` set), the decrypted fields and each lead's note count.
 */
async function toRecords(
  sb: SupabaseClient,
  svc: SupabaseClient | null,
  tenantId: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const stageIds = new Set(rows.map((row) => row['stage_id']).filter(Boolean));
  const stages = new Map<string, string>();
  if (stageIds.size > 0) {
    const { data, error } = await sb
      .from('lead_stages')
      .select('id,label')
      .eq('tenant_id', tenantId);
    if (error) throw new Error(`export stages: ${error.code ?? 'no code'}`);
    for (const stage of (data ?? []) as { id: string; label: string }[]) {
      stages.set(stage.id, stage.label);
    }
  }

  const people = new Map<string, string>();
  if (rows.some((row) => typeof row['assigned_to'] === 'string')) {
    const { data, error } = await sb.rpc('crm_people', { p_tenant: tenantId });
    if (error) throw new Error(`export people: ${error.code ?? 'no code'}`);
    for (const person of (data ?? []) as { id: string; display_name: string | null }[]) {
      people.set(person.id, person.display_name ?? '');
    }
  }

  let noteCounts: Record<string, unknown> = {};
  if (svc && rows.length > 0) {
    const { data, error } = await svc.rpc('crm_lead_note_counts', {
      p_tenant: tenantId,
      p_leads: rows.map((row) => row['id']),
    });
    if (error) throw new Error(`export note counts: ${error.code ?? 'no code'}`);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      noteCounts = data as Record<string, unknown>;
    }
  }

  // The interest labels (Round 3): resolved ONCE for the whole batch — two queries, not
  // two per row — and written as EN + AR columns right after the slug they explain.
  const labels = await resolveLeadInterests(sb, tenantId, rows);

  // `company` is business-contact data in leads_safe (0015), so it is in BOTH projections.
  // `budget` is exported as its human label (BUDGET_BAND_LABELS — the same map the form
  // and the admin panel read), and `timeline` is the decrypted free-text deadline (0017),
  // with the legacy select value alongside for rows that came through the old form.
  const records: Record<string, unknown>[] = [];
  for (const row of rows) {
    const labelled = withInterestLabels(row, labels);
    const assignee = typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null;
    const record: Record<string, unknown> = {
      id: row['id'],
      lead_number: row['lead_number'],
      created_at: row['created_at'],
      status: row['status'],
      stage: typeof row['stage_id'] === 'string' ? (stages.get(row['stage_id']) ?? '') : '',
      spam: row['is_spam'] === true ? 'yes' : 'no',
      name: row['name'],
      company: row['company'],
      service_of_interest: row['service_of_interest'],
      service_label: labelled.service_label?.en ?? '',
      service_label_ar: labelled.service_label?.ar ?? '',
      discipline_of_interest: row['discipline_of_interest'],
      discipline_label: labelled.discipline_label?.en ?? '',
      discipline_label_ar: labelled.discipline_label?.ar ?? '',
      locale: row['locale'],
      message: row['message'],
      // A person no longer working leads keeps the id, so the row still says who it was.
      assignee: assignee ? people.get(assignee) || assignee : '',
      value_sar: row['value_sar'],
      tags: Array.isArray(row['tags']) ? (row['tags'] as string[]).join(', ') : '',
      score: row['score'],
      source: row['source'],
      channel: row['channel'],
    };
    if (svc) {
      record['email'] = await safeDecrypt(row['email_enc']);
      record['phone'] = await safeDecrypt(row['phone_enc']);
      const budget = await safeDecrypt(row['budget_enc']);
      record['budget'] = budget ? budgetBandLabel(budget) : budget;
      record['timeline'] = await safeDecrypt(row['timeline_text_enc']);
      record['timeline_band'] = row['timeline_band'];
      const count = noteCounts[String(row['id'])];
      record['notes_count'] = typeof count === 'number' ? count : 0;
    }
    records.push(record);
  }
  return records;
}

async function safeDecrypt(ciphertext: unknown): Promise<string> {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return '';
  try {
    return await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
  } catch {
    return '';
  }
}
