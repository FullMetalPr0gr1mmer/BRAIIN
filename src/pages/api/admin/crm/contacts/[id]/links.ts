import { ContactLinkSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';
import { contactError, getContact, requireContactId } from '@/lib/crm/contacts';

// The check of a lead matched to this contact by phone alone (Admin v2 C6, the step C5 left
// to this slice; crm.md §5.2): `crm.contacts`. A phone can be shared (an office line), so
// such a lead is not the person's until somebody says so:
//
//   confirm  it is this person: the lead is linked as a person's (`staff`), its e-mail and
//            phone join the contact (copied as ciphertext, never decrypted; an e-mail another
//            contact holds stays there), and its activity counts from then on
//   detach   it is not: the lead leaves the contact for good (never linked again by the
//            nightly run) and the two timeline lines naming the pair go
//
// No staff token may change a lead's link (C5: no UPDATE grant on leads.contact_id), so
// this is the service role's door, public.crm_contact_link_lead, which checks the acting
// profile itself, live; the Worker rechecks it first, and the caller's own client must see
// the contact (RLS, the live check: a 404 otherwise). Audited `crm.contact.link` with the
// lead's id, the action and what was copied (kinds, never values).

export const prerender = false;

const COPY_OUTCOMES = new Set(['added', 'kept', 'elsewhere', 'none']);

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactLinkSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireContactId(params);
    await liveRecheck(auth);
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
      detail: { lead: input.leadId, action: input.action, email: result.email, phone: result.phone },
    });
    return result;
  },
});
