import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, CRM_ERASE_LIMITS } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { newIndexRun, runLeadIndexBackfill } from '@/lib/crm/indexBackfill';
import { getContact, requireContactId } from '@/lib/crm/contacts';

// What erasing a person would remove (Admin v2 C6, crm.md §8.2): `crm.erase`, Admin only. The
// Admin's review before the erasure: counts, and the leads that match the person by phone
// alone (a phone can be shared), each with the lead columns staff read anyway (number, name,
// company, arrival), so the Admin can tick the ones that are this person's.
//
// A POST, not a GET (C6 review, C6-SEC-2): it has effects. It decrypts and indexes leads and
// spends a slot, so it takes the CSRF check every mutation takes and a limit of its own.
//
//   live recheck → its own ledger key (`crm-erase-preview`) at the erasure's numbers (20 an
//   hour per person, 50 per tenant, fail-closed) → the caller's own client must see the
//   contact (RLS; a 404 otherwise) → one batch of the lead index backfill for this tenant only
//   (C5 review, C5-SEC-4: a lead not indexed yet cannot be compared, so the erasure could not
//   find it; the batch makes that rarer, and the count left is shown as `unindexed`; it
//   decrypts e-mail, phone and budget in memory and stores only indexes, as the daily cron
//   does, and this route is one of its two named callers, tests/lib/contactGrants.spec.ts)
//   → public.crm_erase_preview as the service role, which checks the acting profile itself,
//   live (app.crm_eraser_ok).
//
// It reveals no contact detail and changes nothing a person typed, so it is audited queued
// (`crm.erase.preview`, the counts only).

export const prerender = false;

// (Admin v2 C8) `tasks`: the follow-ups that go with the person.
const PREVIEW_COUNTS = ['leads', 'unindexed', 'channels', 'notes', 'tasks'] as const;

interface PhoneMatch {
  id: string;
  lead_number: number | null;
  name: string | null;
  company: string | null;
  created_at: string | null;
  linked: boolean;
}

function phoneMatches(value: unknown): PhoneMatch[] {
  if (!Array.isArray(value)) return [];
  return (value as Record<string, unknown>[])
    .filter((row) => typeof row['id'] === 'string')
    .map((row) => ({
      id: row['id'] as string,
      lead_number: typeof row['lead_number'] === 'number' ? row['lead_number'] : null,
      name: typeof row['name'] === 'string' ? row['name'] : null,
      company: typeof row['company'] === 'string' ? row['company'] : null,
      created_at: typeof row['created_at'] === 'string' ? row['created_at'] : null,
      linked: row['linked'] === true,
    }));
}

export const POST = defineAdminRoute({
  cap: 'crm.erase',
  handler: async ({ auth, sb, params, audit }) => {
    const id = requireContactId(params);
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'crm-erase-preview', CRM_ERASE_LIMITS);
    await getContact(sb, auth, id, 'id');

    const svc = serviceClient();
    const run = newIndexRun();
    try {
      await runLeadIndexBackfill(svc, LEAD_PII_ENC_KEY, undefined, run, auth.tenantId);
    } catch {
      // The preview still answers: what is left unindexed is counted and shown.
    }

    const { data, error } = await svc.rpc('crm_erase_preview', {
      p_tenant: auth.tenantId,
      p_contact: id,
      p_actor: auth.userId,
    });
    if (error) {
      if (error.code === 'P0002') throw new NotFoundError('contact');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.erase', 'the database refused this person');
      }
      throw new Error(`crm_erase_preview: ${error.code ?? 'no code'}`);
    }
    const body = (data ?? {}) as Record<string, unknown>;
    const counts: Record<string, number> = {};
    for (const key of PREVIEW_COUNTS) {
      counts[key] = typeof body[key] === 'number' ? body[key] : 0;
    }
    const matches = phoneMatches(body['phone_matches']);

    audit({
      action: 'crm.erase.preview',
      entityType: 'contact',
      entityId: id,
      detail: { target: 'contact', ...counts, phone_matches: matches.length, indexed: run.indexed },
    });
    return { counts, phoneMatches: matches };
  },
});
