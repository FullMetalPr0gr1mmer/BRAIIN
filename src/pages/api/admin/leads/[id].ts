import { z } from 'zod';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { LeadUpdateSchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { getRow } from '@/lib/admin/crud';
import { decryptPII } from '@/lib/crypto/pii';
import {
  FULL_LEAD_COLUMNS,
  SAFE_LEAD_COLUMNS,
  canSeeLeadPii,
  leadColumnsFor,
  stripSensitive,
} from '@/lib/admin/leadFields';
import { liveRecheck } from '@/lib/admin/liveRecheck';

// A single lead, and the only place envelope-encrypted PII is ever decrypted for the
// admin (CLAUDE.md Pillar 1: "role-checked decrypt path as the gate of record").
//
// Three gates stack here, and each one alone would be insufficient:
//   1. RLS       — `leads_admin_dev_all` scopes rows to Admin + Developer in-tenant
//   2. assertCap — `leads.manage` for the row, `leads.pii` for the plaintext
//   3. the KEY   — the ciphertext is useless without LEAD_PII_ENC_KEY, which is an
//                  `astro:env` secret the browser bundle cannot reach at all
//
// Every decryption is audited BEFORE the plaintext is returned. If the audit write
// fails the request fails: an unlogged read of someone's phone number is the one
// outcome PDPL accountability cannot tolerate, and "the log was down" is not a defence.

export const prerender = false;

const DECRYPTED_FIELDS = ['email', 'phone', 'budget'] as const;

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

    const row = await getRow<Record<string, unknown>>(
      sb,
      'leads',
      auth,
      id,
      wantsPii ? FULL_LEAD_COLUMNS : SAFE_LEAD_COLUMNS,
    );

    if (!wantsPii) {
      audit({ action: 'lead.view', entityType: 'lead', entityId: id, detail: { pii: false } });
      return stripSensitive(row);
    }

    // Re-verify against the live profile row immediately before decrypting — a session
    // that was Developer when the request arrived may not be one now.
    await liveRecheck(auth);

    const decrypted: Record<string, string | null> = {};
    for (const field of DECRYPTED_FIELDS) {
      const ciphertext = row[`${field === 'budget' ? 'budget' : field}_enc`];
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

    // Field NAMES only. An audit entry that quoted the decrypted values would move the
    // PII into a table that is append-only and un-deletable by design — the retention
    // purge could never reach it.
    audit({
      action: 'lead.view_pii',
      entityType: 'lead',
      entityId: id,
      detail: { pii: true, fields: [...DECRYPTED_FIELDS] },
    });

    const { email_enc: _e, phone_enc: _p, budget_enc: _b, ...rest } = row;
    return { ...rest, ...decrypted };
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
        const { AuthorizationError } = await import('@/lib/authz/errors');
        throw new AuthorizationError('leads.pii', `role '${auth.role}' cannot write notes`);
      }
      values['internal_notes'] = input.internalNotes;
    }

    if (Object.keys(values).length === 0) {
      const { ValidationError } = await import('@/lib/admin/errors');
      throw new ValidationError('no updatable fields supplied');
    }

    const { data, error } = await sb
      .from('leads')
      .update(values)
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .select(leadColumnsFor(auth.role))
      .maybeSingle();
    if (error) throw new Error(`update lead: ${error.message}`);
    if (!data) throw new NotFoundError('lead');

    audit({
      action: 'lead.update',
      entityType: 'lead',
      entityId: id,
      detail: { fields: Object.keys(values), status: values['status'] ?? null },
    });
    // `as unknown as` because leadColumnsFor() builds the select list at runtime, and
    // PostgREST's typings parse that string at the TYPE level — a non-literal defeats
    // the parser and it degrades to an error type rather than a row type.
    return stripSensitive(data as unknown as Record<string, unknown>);
  },
});
