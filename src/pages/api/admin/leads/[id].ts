import { z } from 'zod';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadUpdateSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { decryptPII } from '@/lib/crypto/pii';
import {
  GATED_LEAD_COLUMNS,
  SAFE_LEAD_COLUMNS,
  canSeeLeadPii,
  stripSensitive,
} from '@/lib/admin/leadFields';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// A single lead, and the only place envelope-encrypted PII is ever decrypted for the
// admin (CLAUDE.md Pillar 1: "role-checked decrypt path as the gate of record").
//
// Four gates stack here, and each one alone would be insufficient:
//   1. RLS       — `leads_read` scopes rows to Admin + Developer in-tenant, and the
//                  RESTRICTIVE `leads_live` re-reads the profile, so a demoted, inactive
//                  or locked token sees no lead at all (0033)
//   2. GRANTS    — the caller's client can read only the safe columns (0033). The gated
//                  ones are read as the service role, here and in the export, and only
//                  after gates 1, 3 and the audit row
//   3. assertCap — `leads.manage` for the row, `leads.pii` for the plaintext, then a live
//                  recheck of the profile
//   4. the KEY   — the ciphertext is useless without LEAD_PII_ENC_KEY, which is an
//                  `astro:env` secret the browser bundle cannot reach at all
//
// Every decryption is audited BEFORE the plaintext is returned. If the audit write
// fails the request fails: an unlogged read of someone's phone number is the one
// outcome PDPL accountability cannot tolerate, and "the log was down" is not a defence.
// That is why the reveal writes its row DIRECTLY (writeAudit, checked) instead of the
// kernel's queued `audit()`: the queue is flushed after the handler returns and a failed
// write there cannot stop a response that already holds the plaintext. The job
// applications reveal (applications/[id].ts) works the same way.

export const prerender = false;

/** Decrypted response field → the ciphertext column it comes from. */
const DECRYPTED_FIELDS = {
  email: 'email_enc',
  phone: 'phone_enc',
  budget: 'budget_enc',
  // The v2 form's free-text "When do you need it?" (migration 0017) — a §3 timeline field.
  timeline: 'timeline_text_enc',
} as const;

function requireId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('lead');
  return id;
}

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  handler: async ({ auth, sb, url, params, audit }) => {
    const id = requireId(params);
    const wantsPii = url.searchParams.get('pii') === '1' && canSeeLeadPii(auth.role);

    if (!wantsPii) {
      const row = await getRow<Record<string, unknown>>(sb, 'leads', auth, id, SAFE_LEAD_COLUMNS);
      // Readable labels for the interest slugs (Round 3) — derived, never columns.
      const labels = await resolveLeadInterests(sb, auth.tenantId, [row]);
      audit({ action: 'lead.view', entityType: 'lead', entityId: id, detail: { pii: false } });
      return withInterestLabels(stripSensitive(row), labels);
    }

    // Re-verify against the live profile row BEFORE any ciphertext is read — a session
    // that was Developer when the request arrived may not be one now.
    await liveRecheck(auth);

    // The caller's own client must see this lead (RLS, live check included). A lead it
    // cannot see is a 404 before anything is audited or read.
    const row = await getRow<Record<string, unknown>>(sb, 'leads', auth, id, SAFE_LEAD_COLUMNS);

    // Fail closed, before any gated column leaves the database. Field NAMES only: an
    // audit entry that quoted the decrypted values would move the PII into a table that
    // is append-only and un-deletable by design — the retention purge could never reach it.
    const logged = await writeAudit(sb, auth, {
      action: 'lead.view_pii',
      entityType: 'lead',
      entityId: id,
      detail: { pii: true, fields: Object.keys(DECRYPTED_FIELDS) },
    });
    if (!logged) throw new AuthorizationError('leads.pii', 'audit unavailable — refused');

    const gated = await readGatedColumns(auth.tenantId, id);

    const decrypted: Record<string, string | null> = {};
    for (const [field, column] of Object.entries(DECRYPTED_FIELDS)) {
      const ciphertext = gated[column];
      if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
        decrypted[field] = null;
        continue;
      }
      try {
        decrypted[field] = await decryptPII(ciphertext, LEAD_PII_ENC_KEY);
      } catch {
        // A record that will not decrypt is a data-integrity problem, not an authz one.
        // Surfacing it as null keeps the rest of the lead readable.
        decrypted[field] = null;
      }
    }

    const labels = await resolveLeadInterests(sb, auth.tenantId, [row]);
    // timeline_band, internal_notes and ip_inet are gated but not encrypted: they go back
    // as stored. The four ciphertext columns never do.
    const { email_enc: _e, phone_enc: _p, budget_enc: _b, timeline_text_enc: _t, ...plain } = gated;
    return { ...withInterestLabels(row, labels), ...plain, ...decrypted };
  },
});

/**
 * The gated columns of ONE lead, as the service role, scoped to the caller's tenant.
 * `authenticated` cannot read them at all (0033), so this is the only way the reveal gets
 * them, and it runs only after the RLS read, the live recheck and the audit row above.
 */
async function readGatedColumns(tenantId: string, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await serviceClient()
    .from('leads')
    .select(GATED_LEAD_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`read lead pii: ${error.message}`);
  // Deleted between the RLS read and now (retention, erasure): the same answer as unseen.
  if (!data) throw new NotFoundError('lead');
  return data as Record<string, unknown>;
}

export const PATCH = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadUpdateSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireId(params);

    const values: Record<string, unknown> = {};
    if (input.status !== undefined) values['status'] = input.status;
    if (input.internalNotes !== undefined) {
      // internal_notes is one of the four `leads.pii` columns. `leads.manage` alone
      // lets you move a lead to "in progress"; it does not let you write the private
      // commentary attached to a named person.
      await liveRecheck(auth);
      if (!canSeeLeadPii(auth.role)) {
        throw new AuthorizationError('leads.pii', `role '${auth.role}' cannot write notes`);
      }
      values['internal_notes'] = input.internalNotes;
    }

    if (Object.keys(values).length === 0) {
      const { ValidationError } = await import('@/lib/admin/errors');
      throw new ValidationError('no updatable fields supplied');
    }

    // The row comes back with the safe columns only, whoever asks: the caller's client
    // cannot read the gated ones (0033), and writing notes needs no read. The panel
    // reloads the lead (through the audited reveal) after saving.
    const { data, error } = await sb
      .from('leads')
      .update(values)
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .select(SAFE_LEAD_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`update lead: ${error.message}`);
    if (!data) throw new NotFoundError('lead');

    audit({
      action: 'lead.update',
      entityType: 'lead',
      entityId: id,
      detail: { fields: Object.keys(values), status: values['status'] ?? null },
    });
    // `as unknown as` because the select list is a shared constant, and PostgREST's
    // typings parse that string at the TYPE level — a non-literal defeats the parser and
    // it degrades to an error type rather than a row type.
    const updated = stripSensitive(data as unknown as Record<string, unknown>);
    const labels = await resolveLeadInterests(sb, auth.tenantId, [updated]);
    return withInterestLabels(updated, labels);
  },
});
