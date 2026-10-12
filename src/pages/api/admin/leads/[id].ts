import { z } from 'zod';
import { LeadPatchSchema, VERSIONED_LEAD_FIELDS } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow, updateRow } from '@/lib/admin/crud';
import {
  LEAD_WRITE_COLUMNS,
  SAFE_LEAD_COLUMNS,
  canSeeLeadPii,
  stripSensitive,
} from '@/lib/admin/leadFields';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { LEAD_CONSTRAINTS, leadPatchValues, leadWriteError } from '@/lib/crm/leadWrite';
import { PLAIN_GATED_FIELDS, revealLead } from '@/lib/crm/reveal';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// A single lead. With `?pii=1` this is the legacy panel's contact-details reveal; the CRM
// uses POST /api/admin/leads/[id]/reveal. Both go through revealLead (src/lib/crm/reveal.ts),
// the one place the admin decrypts lead PII (CLAUDE.md Pillar 1: "role-checked decrypt
// path as the gate of record"): live recheck, rate limit, RLS read, an audit row written
// BEFORE anything gated is read (fail-closed), then the gated columns as the service role.
//
// Four gates stack here, and each one alone would be insufficient:
//   1. RLS       — `leads_read` scopes rows to Admin + Developer in-tenant, and the
//                  RESTRICTIVE `leads_live` re-reads the profile, so a demoted, inactive
//                  or locked token sees no lead at all (0033)
//   2. GRANTS    — the caller's client can read only the safe columns (0033). The gated
//                  ones are read as the service role, by revealLead and the export only
//   3. assertCap — `leads.manage` for the row, `leads.pii` for the plaintext, then a live
//                  recheck of the profile
//   4. the KEY   — the ciphertext is useless without LEAD_PII_ENC_KEY, which is an
//                  `astro:env` secret the browser bundle cannot reach at all

export const prerender = false;

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

    // The legacy shape: the safe row, the gated-but-plain fields (timeline_band,
    // internal_notes, ip_inet) and the decrypted ones. Never a ciphertext column.
    const { row, plain, decrypted } = await revealLead(auth, sb, id, PLAIN_GATED_FIELDS);
    const labels = await resolveLeadInterests(sb, auth.tenantId, [row]);
    return { ...withInterestLabels(row, labels), ...plain, ...decrypted };
  },
});

// Changing a lead (Admin v2 C3): `leads.manage`. Since 0041 staff write the pipeline
// through a column grant, as the caller (RLS and the live check decide which lead), so this
// route adds the Worker's half: Zod, the version, and the audit row.
//
//   • stageId, isSpam, assignedTo, valueSar and tags move the lead's version, so they need
//     the version the caller read: a stale one is a 409 (crud.ts updateRow tells it apart
//     from a 404), never a silent overwrite of a colleague's change.
//   • isStarred, read and logContact never move it (a star or a read mark must not turn
//     every open lead into a conflict); the database stamps the read mark and the contact
//     with its own clock and the session's person.
//   • status and internalNotes are the legacy panel's, kept until C4 moves it to the
//     pipeline and the notes thread. internal_notes is a leads.pii column, so writing it
//     adds that capability and a live recheck.
export const PATCH = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadPatchSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireId(params);

    if (input.internalNotes !== undefined) {
      // `leads.manage` alone moves a lead; it does not write the private commentary
      // attached to a named person.
      await liveRecheck(auth);
      if (!canSeeLeadPii(auth.role)) {
        throw new AuthorizationError('leads.pii', `role '${auth.role}' cannot write notes`);
      }
    }

    const values = leadPatchValues(input, new Date());
    const versioned = VERSIONED_LEAD_FIELDS.some((field) => input[field] !== undefined);

    // The row comes back with the safe and pipeline columns only, whoever asks: the
    // caller's client cannot read the gated ones (0033), and writing notes needs no read.
    // `as unknown as` below because the select list is a shared constant, and PostgREST's
    // typings parse that string at the TYPE level: a non-literal degrades to an error type.
    let row: Record<string, unknown>;
    if (versioned) {
      // The schema refuses a versioned change without it; this keeps the types honest.
      if (input.version === undefined)
        throw new ValidationError('send the version you read', 'version');
      row = await updateRow<Record<string, unknown>>(
        sb,
        'leads',
        auth,
        id,
        input.version,
        values,
        LEAD_WRITE_COLUMNS,
        { constraints: LEAD_CONSTRAINTS },
      );
    } else {
      const { data, error } = await sb
        .from('leads')
        .update(values)
        .eq('tenant_id', auth.tenantId)
        .eq('id', id)
        .select(LEAD_WRITE_COLUMNS)
        .maybeSingle();
      if (error) throw leadWriteError(error, 'update lead');
      if (!data) throw new NotFoundError('lead');
      row = data as unknown as Record<string, unknown>;
    }

    // Field names, the legacy status and the stage id: never notes, tags or values.
    audit({
      action: 'lead.update',
      entityType: 'lead',
      entityId: id,
      detail: {
        fields: Object.keys(values),
        status: input.status ?? null,
        ...(input.stageId !== undefined ? { stage: input.stageId } : {}),
      },
    });
    const updated = stripSensitive(row);
    const labels = await resolveLeadInterests(sb, auth.tenantId, [updated]);
    return withInterestLabels(updated, labels);
  },
});
