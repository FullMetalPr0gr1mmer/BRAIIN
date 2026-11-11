import { ContactCompanySchema } from '@schemas/crmCompanies';
import { defineAdminRoute } from '@/lib/admin/route';
import { getContact, requireContactId } from '@/lib/crm/contacts';
import { companyError } from '@/lib/crm/companies';

// A contact's company (Admin v2 C11, crm.md §5.3 and §11 screen 6): `crm.contacts`, at the
// contact's version (a 409 when it moved). One transaction in the database
// (public.crm_contact_company, SECURITY INVOKER, so RLS and the live check decide):
//   link    a company the caller sees (another tenant's or an unseen one is a 422);
//   create  "Create company from this name": the company the contact's free text names, found
//           by the names' folding or made as the caller's, then linked;
//   unlink  the free text keeps the last name (C7's field keeps working).
// While linked, the contact's company name is the company's (kept in step by the database).
// The contact is answered as the contact page reads it, so the page draws the new version.
// Audited `crm.contact.update` with the field and the action, never a name.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactCompanySchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireContactId(params);
    const { data, error } = await sb.rpc('crm_contact_company', {
      p_tenant: auth.tenantId,
      p_contact: id,
      p_version: input.version,
      p_action: input.action,
      p_company: input.action === 'link' ? input.companyId : null,
    });
    if (error) throw companyError(error, "the contact's company", 'contact');
    const answer = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const companyId = typeof answer['company_id'] === 'string' ? answer['company_id'] : null;
    const how = typeof answer['how'] === 'string' ? answer['how'] : input.action;
    audit({
      action: 'crm.contact.update',
      entityType: 'contact',
      entityId: id,
      detail: { fields: ['company'], action: input.action, how, ...(companyId ? { company: companyId } : {}) },
    });
    const { merged_into: _merged, ...contact } = await getContact(sb, auth, id);
    return { contact, companyId, how };
  },
});
