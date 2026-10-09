import { z } from 'zod';
import { LeadEraseSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { getRow } from '@/lib/admin/crud';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, CRM_ERASE_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';

// Erasing a lead (Admin v2 C3, crm.md §8.2): `crm.erase`, Admin only (CLAUDE.md §5). It
// cannot be undone, so it runs the privileged-path order, each step before the next and
// any failure stopping everything after it:
//
//   1. assertCap('crm.erase')     the kernel
//   2. live recheck               the profile, now (demotion effective immediately)
//   3. rate limit                 20 an hour per person, 50 per tenant (O-9), fail-closed
//   4. RLS read                   the caller's own client must see the lead; an unseen
//                                 lead is a 404 before anything is written
//   5. attempt audit, WRITTEN     fail-closed: no row, no erase
//   6. public.crm_erase_lead      as the service role (no API role may delete a lead,
//                                 0030): the lead and, by cascade, its notes and timeline,
//                                 in one transaction. The database checks the acting
//                                 profile itself, live, through app.role_crm_erase
//   7. outcome audit              with the counts, or the failure
//
// The audit rows carry ids, the lead's number, the reason and the counts: never the
// person's name or details, which is what is being erased. Backups keep an erased row
// until they roll over (PITR 28 days); the privacy notice says so (owner item O-11).

export const prerender = false;

function requireId(params: Record<string, string | undefined>): string {
  const id = params['id'];
  if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('lead');
  return id;
}

/** What crm_erase_lead answers: the lead's number and how many rows went. */
function counts(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of ['lead_number', 'leads', 'notes', 'events']) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'number') out[key] = value;
    }
  }
  return out;
}

export const POST = defineAdminRoute({
  cap: 'crm.erase',
  input: LeadEraseSchema,
  handler: async ({ auth, sb, input, params }) => {
    const id = requireId(params);
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'crm-erase', CRM_ERASE_LIMITS);
    const lead = await getRow<{ id: string; lead_number?: number }>(
      sb,
      'leads',
      auth,
      id,
      'id,lead_number',
    );

    const logged = await writeAudit(sb, auth, {
      action: 'crm.erase.attempt',
      entityType: 'lead',
      entityId: id,
      detail: { target: 'lead', reason: input.reason, lead_number: lead.lead_number ?? null },
    });
    if (!logged) throw new AuthorizationError('crm.erase', 'audit unavailable, erase refused');

    const { data, error } = await serviceClient().rpc('crm_erase_lead', {
      p_tenant: auth.tenantId,
      p_lead: id,
      p_actor: auth.userId,
    });
    if (error) {
      await writeAudit(sb, auth, {
        action: 'crm.erase.outcome',
        entityType: 'lead',
        entityId: id,
        detail: { target: 'lead', status: 'failed', code: error.code ?? null },
      });
      // Gone between the read and the erase (retention, a colleague): the same as unseen.
      if (error.code === 'P0002') throw new NotFoundError('lead');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.erase', 'the database refused this person');
      }
      throw new Error(`crm_erase_lead: ${error.code ?? 'no code'}`);
    }

    const erased = counts(data);
    await writeAudit(sb, auth, {
      action: 'crm.erase.outcome',
      entityType: 'lead',
      entityId: id,
      detail: { target: 'lead', status: 'ok', reason: input.reason, ...erased },
    });
    return { erased: true, counts: erased };
  },
});
