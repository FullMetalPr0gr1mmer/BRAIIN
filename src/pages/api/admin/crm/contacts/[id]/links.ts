import { ContactLinkSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, PII_REVEAL_LIMITS } from '@/lib/admin/rateLimit';
import { receivesLeadPiiUnasked } from '@/lib/admin/leadFields';
import { CONTACT_REVEAL_OP } from '@/lib/crm/contactReveal';
import { serviceClient } from '@/lib/supabase/server';
import { contactError, getContact, requireContactId } from '@/lib/crm/contacts';

// The check of a lead matched to this contact by phone alone (Admin v2 C6, the step C5 left
// to this slice; crm.md §5.2): `crm.contacts`. A phone can be shared (an office line), so
// such a lead is not the person's until somebody says so:
//
//   confirm  it is this person: the lead is linked as a person's (`staff`), its e-mail and
//            phone join the contact (copied as ciphertext, never decrypted; an e-mail another
//            contact holds stays there, and a contact keeps at most ten e-mails and ten
//            phones, so one reveal never shows a crowd), and its activity counts from then on
//   detach   it is not: the lead leaves the contact for good (never linked again by the
//            nightly run) and the two timeline lines naming the pair go
//
// No staff token may change a lead's link (C5: no UPDATE grant on leads.contact_id), so
// this is the service role's door, public.crm_contact_link_lead, which checks the acting
// profile itself, live; the Worker rechecks it first, and the caller's own client must see
// the contact (RLS, the live check: a 404 otherwise). Audited `crm.contact.link` with the
// lead's id, the action and what was copied (kinds, never values).
//
// One reveal stays one person (Admin v2 C10b, crm.md §10, C6-SEC-3): a confirm copies that
// lead's e-mail and phone into the contact, and the contact's next reveal decrypts them. A
// role that cannot export (Sales: `leads.pii` one lead at a time, never `export.csv`) spends a
// slot of the reveal's own limiter for it (`pii-reveal`, fail-closed, after the live recheck
// and before anything is read), as if it had revealed that lead; so what a confirm brings has
// cost it a slot, and every door that adds a channel keeps to C6's ceiling (ten of each kind;
// the arrival's link too since the C10b review), so one reveal shows at most twenty values.
// Any later door that moves another record's channels into a contact does the same. Admin
// and Developer may take every lead's details at once anyway (`receivesLeadPiiUnasked`), so
// their confirm spends none. A detach copies nothing and spends none.

export const prerender = false;

// `full`: the contact keeps as many of that kind as it may (ten), so nothing was copied
// (C6 review, C6-SEC-3).
const COPY_OUTCOMES = new Set(['added', 'kept', 'elsewhere', 'full', 'none']);

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactLinkSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireContactId(params);
    await liveRecheck(auth);
    if (input.action === 'confirm' && !receivesLeadPiiUnasked(auth.role)) {
      await claimPrivilegedOp(auth, CONTACT_REVEAL_OP, PII_REVEAL_LIMITS);
    }
    await getContact(sb, auth, id, 'id');

    const { data, error } = await serviceClient().rpc('crm_contact_link_lead', {
      p_tenant: auth.tenantId,
      p_contact: id,
      p_lead: input.leadId,
      p_action: input.action,
      p_actor: auth.userId,
    });
    if (error) throw contactError(error, 'the link');
    const answer = (data ?? {}) as Record<string, unknown>;
    const copied = (key: string) => {
      const value = answer[key];
      return typeof value === 'string' && COPY_OUTCOMES.has(value) ? value : null;
    };
    const result = {
      link: input.action === 'confirm' ? 'staff' : 'detached',
      email: input.action === 'confirm' ? copied('email') : null,
      phone: input.action === 'confirm' ? copied('phone') : null,
    };
    audit({
      action: 'crm.contact.link',
      entityType: 'contact',
      entityId: id,
      detail: {
        lead: input.leadId,
        action: input.action,
        email: result.email,
        phone: result.phone,
      },
    });
    return result;
  },
});
