import { z } from 'zod';
import { LeadUpdateSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { SAFE_LEAD_COLUMNS, canSeeLeadPii, stripSensitive } from '@/lib/admin/leadFields';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { revealLead } from '@/lib/crm/reveal';
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

    const { row, plain, decrypted } = await revealLead(auth, sb, id);
    const labels = await resolveLeadInterests(sb, auth.tenantId, [row]);
    // The legacy shape: the safe row, the gated-but-plain fields (timeline_band,
    // internal_notes, ip_inet) and the decrypted ones. Never a ciphertext column.
    return { ...withInterestLabels(row, labels), ...plain, ...decrypted };
  },
});

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
