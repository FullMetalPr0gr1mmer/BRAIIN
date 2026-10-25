import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadExportQuerySchema, type LeadExportQuery } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { canSeeLeadPii, GATED_LEAD_COLUMNS, SAFE_LEAD_COLUMNS } from '@/lib/admin/leadFields';
import { AuthorizationError } from '@/lib/authz/errors';
import { decryptPII, importPIIKey } from '@/lib/crypto/pii';
import { budgetBandLabel } from '@schemas/lead';
import { SlugSchema } from '@schemas/primitives';
import { writeSystemLog } from '@/lib/data/systemLog';
import { isSameSiteGet } from '@/lib/http/csrf';
import { toCsv } from '@/lib/admin/csv';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { serviceClient } from '@/lib/supabase/server';
import {
  afterFilter,
  disciplineFilter,
  EXPORT_ROW_CAP,
  exportsSpam,
  readPaged,
  type ExportPage,
} from '@/lib/crm/exportRead';

// Lead CSV export — the full §3 lockdown, in order:
//
//   1. assertCap('export.csv')          Admin + Developer only
//      + this site only                 a cross-site link is refused before anything is
//                                       spent (isSameSiteGet: Admin v2 U13 review)
//   2. liveRecheck()                    demotion effective immediately
//   3. rate limit                       3/hr/user AND 10/hr/tenant, fail-closed
//   4. audit entry #1 — ATTEMPT         written BEFORE any lead is read, and FATAL if
//                                       it fails: "we could not record that someone
//                                       exported the lead table" is a reason not to
//   5. the dump itself                  tenant-scoped, capped; with PII it reads as the
//                                       service role, because staff tokens cannot read
//                                       the gated columns at all (0033)
//   6. audit entry #2 — OUTCOME         with the row count, once the file is built; a
//                                       handled failure after step 4 writes a failed one
//   7. abnormal-volume alert            an export that reaches its cap
//
// Step 4 is the one that is easy to get backwards. Writing a single audit row after a
// successful export means a dump that crashed, timed out, or was cancelled mid-stream
// leaves no trace — and those are exactly the shapes an exfiltration attempt has.
//
// Since Admin v2 C3 the export follows the list's filters a link may carry (stage, spam,
// a date range, and since C4a the assignee, source, channel, discipline, star and read
// mark; never the search, which would sit in the URL), with the list's defaults (no spam
// unless asked, `to` exclusive), and carries the pipeline: the lead's number, stage,
// spam flag, assignee, value, tags, score, source and channel. Note BODIES are not exported,
// only how many notes a lead has: bulk free text about named people is the riskiest thing a
// file can hold (crm.md §9). The read is keyset-paged (src/lib/crm/exportRead.ts), so the
// cap really is the cap: one unpaged read was cut at 1,000 by the API's row limit without a
// word, and an export that stops short says so (`truncated`): in its outcome row, in the
// `x-export-truncated` header a screen can read, and in the file's name, which a plain
// download link shows. The cap is set by CPU (EXPORT_ROW_CAP, measured): a PII export decrypts
// four fields a row, so it imports the key once for the request, not once per field.
//
// Since Admin v2 C14a the export names none of the legacy columns the contract slice drops
// (C14b), so it runs on the schema before and after that migration: no `status` column or
// filter (a lead moves by its stage, which the file carries), no `timeline_band` (the daily
// cron moved each band into the encrypted timeline, 0035), and never the notes field or the
// address, as before. The notes are the thread: the file carries each lead's note COUNT, read
// as the service role through public.crm_lead_note_counts, never a note's words (crm.md §9,
// "Note bodies are not exported"); the words leave only through the thread's own audited door.

export const prerender = false;

/** The pipeline's columns the export carries (all readable by staff since 0034 to 0041). */
const PIPELINE_COLUMNS =
  'lead_number,stage_id,is_spam,assigned_to,value_sar,tags,score,source,channel';

/**
 * The gated columns a PII export decrypts: never the score's reasons (C4a: they leave only
 * through the one-lead reveal, D7).
 */
const NOT_EXPORTED = new Set(['score_signals']);
const PII_COLUMNS = GATED_LEAD_COLUMNS.split(',')
  .filter((column) => !NOT_EXPORTED.has(column))
  .join(',');

const SAFE_HEADER = [
  'id',
  'lead_number',
  'created_at',
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
  ...SAFE_HEADER.slice(SAFE_HEADER.indexOf('company') + 1),
  'notes_count',
];

/** What the filters need beyond the link: whose "me" is, and a discipline's services. */
interface FilterContext {
  /** The session's user: `assigned=me` is always the caller, never a value in the link. */
  userId: string;
  /** The discipline filter's service slugs (null when the link names no discipline). */
  disciplineServices: string[] | null;
}

/**
 * One page of the leads matching the filters, newest first (src/lib/crm/exportRead.ts pages
 * through them). `tenantId` is the session's: for a PII export the reader is the service role,
 * which bypasses RLS, so this filter is the tenant fence (tests/lib/leadExportTenant.spec.ts).
 * The filters are the list's (app.lead_filter, 0063), as PostgREST filters on each page.
 */
function leadPage(
  reader: SupabaseClient,
  tenantId: string,
  columns: string,
  input: LeadExportQuery,
  context: FilterContext,
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
    if (input.stage) query = query.eq('stage_id', input.stage);
    if (input.from) query = query.gte('created_at', input.from);
    if (input.to) query = query.lt('created_at', input.to);
    // (C4a) whose, where from, marks, discipline
    if (input.assigned === 'me') query = query.eq('assigned_to', context.userId);
    else if (input.assigned === 'none') query = query.is('assigned_to', null);
    else if (input.assigned) query = query.eq('assigned_to', input.assigned);
    if (input.source) query = query.eq('source', input.source);
    if (input.channel) query = query.eq('channel', input.channel);
    if (input.starred) query = query.eq('is_starred', input.starred === 'true');
    if (input.unread === 'true') query = query.is('read_at', null);
    else if (input.unread === 'false') query = query.not('read_at', 'is', null);
    if (input.discipline && context.disciplineServices) {
      query = query.or(disciplineFilter(input.discipline, context.disciplineServices));
    }
    if (after) query = query.or(afterFilter(after));
    const { data, error } = await query;
    if (error) throw new Error(`export leads: ${error.code ?? 'no code'}`);
    // See leads/[id].ts: the column list is chosen at runtime, which PostgREST's
    // literal-string typings cannot follow.
    return (data ?? []) as unknown as Record<string, unknown>[];
  };
}

/**
 * The slugs of a discipline's services, read as the caller (staff read every status, as the
 * list's filter does in SQL). Two small reads, once per export, not per page.
 */
async function disciplineServices(
  sb: SupabaseClient,
  tenantId: string,
  discipline: string,
): Promise<string[]> {
  const found = await sb
    .from('disciplines')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('slug', discipline)
    .maybeSingle<{ id: string }>();
  if (found.error) throw new Error(`export discipline: ${found.error.code ?? 'no code'}`);
  if (!found.data) return [];
  const { data, error } = await sb
    .from('services')
    .select('slug')
    .eq('tenant_id', tenantId)
    .eq('discipline_id', found.data.id);
  if (error) throw new Error(`export discipline services: ${error.code ?? 'no code'}`);
  return ((data ?? []) as { slug: unknown }[])
    .map((row) => row.slug)
    .filter((slug): slug is string => SlugSchema.safeParse(slug).success);
}

export const GET = defineAdminRoute({
  cap: 'export.csv',
  input: LeadExportQuerySchema,
  handler: async ({ auth, sb, input, request }) => {
    // A plain-link GET with side effects (a limiter slot, two audit rows): never on another
    // site's say-so (src/lib/http/csrf.ts isSameSiteGet), and before anything is spent.
    if (!isSameSiteGet(request))
      throw new AuthorizationError('export.csv', 'cross-site export refused');
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
        stage: input.stage ?? null,
        spam: input.spam ?? null,
        assigned: input.assigned ?? null,
        source: input.source ?? null,
        channel: input.channel ?? null,
        discipline: input.discipline ?? null,
        starred: input.starred ?? null,
        unread: input.unread ?? null,
      },
    });
    if (!attemptLogged) {
      throw new AuthorizationError('export.csv', 'audit unavailable, export refused');
    }

    const cap = withPii ? EXPORT_ROW_CAP.pii : EXPORT_ROW_CAP.safe;
    let csv: string;
    let rows: number;
    let truncated: boolean;
    try {
      // The gated columns are refused to the caller's own client (0033), so a PII export
      // reads as the service role: only after steps 1-4, and scoped to the caller's tenant
      // here, since the service role bypasses RLS. Without PII it stays on the caller's
      // client and RLS.
      const svc = withPii ? serviceClient() : null;
      const reader = svc ?? sb;
      const columns = `${SAFE_LEAD_COLUMNS},${PIPELINE_COLUMNS}${withPii ? `,${PII_COLUMNS}` : ''}`;
      const context: FilterContext = {
        userId: auth.userId,
        disciplineServices: input.discipline
          ? await disciplineServices(sb, auth.tenantId, input.discipline)
          : null,
      };
      const read = await readPaged(leadPage(reader, auth.tenantId, columns, input, context), cap);
      const records = await toRecords(sb, svc, auth.tenantId, read.rows);
      // Built before the outcome row, so an `ok` outcome means the file exists.
      csv = toCsv(withPii ? PII_HEADER : SAFE_HEADER, records);
      rows = records.length;
      truncated = read.truncated;
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
      detail: { status: 'ok', rows, withPii, truncated, cap },
    });

    // An export that reaches its cap pulled the most one file carries: worth a warning line.
    if (rows >= cap) {
      void writeSystemLog({
        level: 'warn',
        source: 'admin:export-csv',
        message: `lead export reached its cap: ${rows} rows${truncated ? ', more matched' : ''}`,
        detail: { actorId: auth.userId, role: auth.role, rows, cap, truncated },
      });
    }

    const day = new Date().toISOString().slice(0, 10);
    const filename = truncated ? `leads-${day}-first-${rows}.csv` : `leads-${day}.csv`;
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
        'x-export-rows': String(rows),
        'x-export-truncated': String(truncated),
      },
    });
  },
});

/**
 * The rows as CSV records: stage labels and assignee names resolved once for the batch
 * (the caller's own client: lead workers read both), interest labels likewise, and, for a
 * PII export (`svc` set), the decrypted fields and each lead's note count. The key is
 * imported once here, for every field of every row: importing it costs about what a decrypt
 * does, and a PII row decrypts four.
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
  // and the admin panel read), and `timeline` is the decrypted deadline: the visitor's own
  // words (0017), or a legacy band's, which the daily cron stored there encrypted (0035).
  const key = svc && rows.length > 0 ? await importPIIKey(LEAD_PII_ENC_KEY) : null;
  const records: Record<string, unknown>[] = [];
  for (const row of rows) {
    const labelled = withInterestLabels(row, labels);
    const assignee = typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null;
    const record: Record<string, unknown> = {
      id: row['id'],
      lead_number: row['lead_number'],
      created_at: row['created_at'],
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
    if (key) {
      record['email'] = await safeDecrypt(row['email_enc'], key);
      record['phone'] = await safeDecrypt(row['phone_enc'], key);
      const budget = await safeDecrypt(row['budget_enc'], key);
      record['budget'] = budget ? budgetBandLabel(budget) : budget;
      record['timeline'] = await safeDecrypt(row['timeline_text_enc'], key);
      const count = noteCounts[String(row['id'])];
      record['notes_count'] = typeof count === 'number' ? count : 0;
    }
    records.push(record);
  }
  return records;
}

async function safeDecrypt(ciphertext: unknown, key: CryptoKey): Promise<string> {
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return '';
  try {
    return await decryptPII(ciphertext, key);
  } catch {
    return '';
  }
}
