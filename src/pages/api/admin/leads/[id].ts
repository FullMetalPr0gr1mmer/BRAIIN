import { z } from 'zod';
import { LeadPatchSchema, VERSIONED_LEAD_FIELDS } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { getRow, updateRow } from '@/lib/admin/crud';
import { LEAD_WRITE_COLUMNS, stripSensitive } from '@/lib/admin/leadFields';
import { LEAD_CONSTRAINTS, leadPatchValues, leadWriteError } from '@/lib/crm/leadWrite';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';

// A single lead: its safe and pipeline columns (GET) and a pipeline change (PATCH). Never its
// contact details. Since Admin v2 C14a the legacy panel's `?pii=1` alias is gone: GET reads no
// query parameter at all, so `?pii=1` answers the same safe row, decrypts nothing and spends
// no reveal slot. The one way to a lead's contact details is POST /api/admin/leads/[id]/reveal
// (src/lib/crm/reveal.ts, CLAUDE.md Pillar 1: "role-checked decrypt path as the gate of
// record"): live recheck, rate limit, RLS read, an audit row written BEFORE anything gated is
// read (fail-closed), then the gated columns as the service role.
//
// The gates on this route, each one alone insufficient:
//   1. RLS       — `leads_read` scopes rows to Admin, Developer and Sales in-tenant
//                  (`app.role_works_leads`, 0097), and the RESTRICTIVE `leads_live`
//                  re-reads the profile, so a demoted, inactive or locked token sees no
//                  lead at all (0033)
//   2. GRANTS    — the caller's client can read only the safe and pipeline columns (0033,
//                  0041); the gated ones are read as the service role, by the reveal and the
//                  export only
//   3. assertCap — `leads.manage`
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
  handler: async ({ auth, sb, params, audit }) => {
    const id = requireId(params);
    // The safe columns and the pipeline's (C4a): the assignee, value, star, read mark, tags
    // and logged contact the lead page shows. Never a gated column (0033's grant refuses
    // them), and never a legacy one (C14a: C14b drops them).
    const row = await getRow<Record<string, unknown>>(sb, 'leads', auth, id, LEAD_WRITE_COLUMNS);
    // Readable labels for the interest slugs (Round 3) — derived, never columns.
    const labels = await resolveLeadInterests(sb, auth.tenantId, [row]);
    audit({ action: 'lead.view', entityType: 'lead', entityId: id, detail: { pii: false } });
    return withInterestLabels(stripSensitive(row), labels);
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
//   • the legacy fields are refused by the schema, each with a 422 naming it: internalNotes
//     since C4b (notes are a thread, written through POST /api/admin/leads/[id]/notes,
//     audited) and status since C10a (a lead moves by its stage; 0097 withdrew the staff
//     UPDATE on both columns).
export const PATCH = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadPatchSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireId(params);
    const values = leadPatchValues(input, new Date());
    const versioned = VERSIONED_LEAD_FIELDS.some((field) => input[field] !== undefined);

    // The row comes back with the safe and pipeline columns only, whoever asks: the
    // caller's client cannot read the gated ones (0033).
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

    // Field names and the stage id: never tags or values.
    audit({
      action: 'lead.update',
      entityType: 'lead',
      entityId: id,
      detail: {
        fields: Object.keys(values),
        ...(input.stageId !== undefined ? { stage: input.stageId } : {}),
      },
    });
    const updated = stripSensitive(row);
    const labels = await resolveLeadInterests(sb, auth.tenantId, [updated]);
    return withInterestLabels(updated, labels);
  },
});
