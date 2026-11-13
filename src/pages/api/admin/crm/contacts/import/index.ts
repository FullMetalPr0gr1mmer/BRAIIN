import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { IMPORT_ATTESTATION, ImportRequestSchema, type ImportRequest } from '@schemas/crmImport';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { readBodyText } from '@/lib/auth/bodyLimit';
import { claimPrivilegedOp, CRM_IMPORT_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { tenantCountry } from '@/lib/crm/leadQuery';
import { importError, importPiece } from '@/lib/crm/importRows';
import { importCounts, readImportBatches } from '@/lib/crm/importBatches';

// Importing contacts from a CSV file (Admin v2 C15, crm.md §12): `crm.import`, Admin only
// (CLAUDE.md §5). A file arrives in pieces of at most 50 people (the Workers Free plan's 10 ms
// of CPU a request; src/lib/crm/importRows.ts), in three steps, each after a live recheck:
//
//   open    the import's own limit (`crm-import`: 5 an hour per person, 10 per tenant,
//           fail-closed), then the ATTEMPT audit row, WRITTEN (fail-closed: no row, no
//           import), then public.crm_import_open as the service role (the actor checked live
//           in SQL; any import this Admin left open is stopped, each with its outcome row)
//   rows    one piece, parsed HERE from its CSV text, every row checked, e-mails and phones
//           encrypted and blind-indexed, then public.crm_import_rows (dedupe, the totals)
//   finish  public.crm_import_finish, then the OUTCOME audit row with the counts
//
// The live recheck runs before the body is read, so a stale token makes the Worker read
// nothing; a body over its cap is refused before it is read whole (a chunked one too: the
// stream is cut at the cap). Every refusal names a column or row number, never a value;
// nothing a row holds reaches an audit row, a log line or an answer.

export const prerender = false;

/** A piece's JSON: its CSV text (at most 200,000 characters, Arabic two bytes each) and more. */
const BODY_CAP = 450_000;
/**
 * The bytes a body of BODY_CAP characters can take in UTF-8 (three a UTF-16 unit at most), so
 * the read's cap never refuses a body the character cap would take.
 */
const BODY_BYTE_CAP = BODY_CAP * 3;

async function readBody(request: Request): Promise<ImportRequest> {
  const text = await readBodyText(request, BODY_BYTE_CAP);
  if (text === null || text.length > BODY_CAP)
    throw new ValidationError('That part of the file is too large to send.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError('body must be valid JSON');
  }
  const parsed = ImportRequestSchema.safeParse(raw);
  // Zod's own words can repeat a value it was sent: never passed on.
  if (!parsed.success) throw new ValidationError('The import request was not understood.');
  return parsed.data;
}

export const GET = defineAdminRoute({
  cap: 'crm.import',
  handler: async ({ auth, sb }) => ({ batches: await readImportBatches(sb, auth) }),
});

export const POST = defineAdminRoute({
  cap: 'crm.import',
  handler: async ({ auth, sb, request }) => {
    await liveRecheck(auth);
    const input = await readBody(request);
    const svc = serviceClient();

    if (input.step === 'open') {
      await claimPrivilegedOp(auth, 'crm-import', CRM_IMPORT_LIMITS);
      const logged = await writeAudit(sb, auth, {
        action: 'crm.import.attempt',
        entityType: 'contact_import',
        detail: { rows: input.rows, bytes: input.bytes, attestation: IMPORT_ATTESTATION },
      });
      if (!logged) throw new AuthorizationError('crm.import', 'audit unavailable, import refused');
      const { data, error } = await svc.rpc('crm_import_open', {
        p_tenant: auth.tenantId,
        p_actor: auth.userId,
        p_rows: input.rows,
        p_bytes: input.bytes,
        p_attestation: IMPORT_ATTESTATION,
      });
      if (error) throw importError(error as { code?: string });
      const answer = (data ?? {}) as { id?: unknown; stopped?: unknown };
      if (typeof answer.id !== 'string') throw new Error('crm_import_open: no id');
      // An import this Admin left open (a closed tab) gets its outcome now.
      for (const stopped of Array.isArray(answer.stopped) ? answer.stopped : []) {
        const id = (stopped as { id?: unknown })?.id;
        if (typeof id !== 'string') continue;
        await writeAudit(sb, auth, {
          action: 'crm.import.outcome',
          entityType: 'contact_import',
          entityId: id,
          detail: { status: 'stopped', left_open: true, ...importCounts(stopped) },
        });
      }
      return { batchId: answer.id };
    }

    if (input.step === 'rows') {
      return importPiece({
        auth,
        svc,
        rootKey: LEAD_PII_ENC_KEY,
        batchId: input.batchId,
        rowNumbers: input.rowNumbers,
        csv: input.csv,
        tenantCountry: tenantCountry(sb, auth.tenantId),
      });
    }

    const { data, error } = await svc.rpc('crm_import_finish', {
      p_tenant: auth.tenantId,
      p_batch: input.batchId,
      p_actor: auth.userId,
      p_stopped: input.stopped === true,
    });
    if (error) throw importError(error as { code?: string });
    const counts = importCounts(data);
    const status = input.stopped === true ? 'stopped' : 'done';
    await writeAudit(sb, auth, {
      action: 'crm.import.outcome',
      entityType: 'contact_import',
      entityId: input.batchId,
      detail: { status, ...counts },
    });
    return { status, counts };
  },
});
