import { ContactNewLeadSchema } from '@schemas/crm';
import { assertCap } from '@/lib/authz/matrix';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp, MANUAL_LEAD_LIMITS } from '@/lib/admin/rateLimit';
import { ingestContactLead } from '@/lib/data/leads';
import { contactError, getContact, requireContactId } from '@/lib/crm/contacts';

// "New lead" for a contact (Admin v2 C6, crm.md §9): `crm.contacts` AND `leads.manage` AND
// `leads.pii`, because it puts a person's contact details on a lead. In order:
//
//   assertCap ×3 → live recheck (the lead is written as the service role) → the manual add's
//   own limit, the SAME ledger key as POST /api/admin/leads (`lead-manual-add`: 60 an hour
//   per person, 300 per tenant, fail-closed), so the two ways of adding a lead by hand share
//   one allowance → the caller's own client must see the contact (RLS, the live check; a 404
//   otherwise), which also gives the lead its default name, company and language →
//   public.crm_contact_new_lead (src/lib/data/leads.ts ingestContactLead), which checks the
//   acting profile itself, live, copies the contact's e-mail and phone as ciphertext, and
//   links the lead to this contact.
//
// Audited `lead.create` with the source, the channel and the contact's id; never the
// person's details.

export const prerender = false;

const NO_CHANNEL =
  'This contact has no e-mail address or phone number yet. Add one to the contact first, then add the lead.';

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactNewLeadSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    assertCap(auth, 'leads.manage');
    assertCap(auth, 'leads.pii');
    const id = requireContactId(params);
    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'lead-manual-add', MANUAL_LEAD_LIMITS);
    const contact = await getContact(sb, auth, id, 'id,display_name,company_name,locale');

    const result = await ingestContactLead(auth.tenantId, auth.userId, id, {
      ...input,
      name: input.name ?? String(contact['display_name']),
      company:
        input.company ??
        (typeof contact['company_name'] === 'string' ? contact['company_name'] : null),
      locale: input.locale ?? (contact['locale'] === 'ar' ? 'ar' : 'en'),
    });
    if (!result.ok) {
      // Everything the request carries is checked above, so the door's 22023 is the one
      // thing it alone can see: a contact with neither an e-mail nor a phone.
      if (result.code === '22023') throw new ValidationError(NO_CHANNEL, 'contact');
      throw contactError(result.code ? { code: result.code } : {}, 'the new lead', 'leads.manage');
    }

    audit({
      action: 'lead.create',
      entityType: 'lead',
      entityId: result.id,
      detail: { source: 'manual', channel: input.channel, contact: id },
    });
    return { id: result.id, contactId: id };
  },
});
