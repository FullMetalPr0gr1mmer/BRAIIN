import { CompanyForgetDomainSchema } from '@schemas/crmCompanies';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { companyError, pickCompany, requireCompanyId } from '@/lib/crm/companies';

// Forget a company's learnt e-mail domain (Admin v2 C11 review, C11-SEC-1). A company the
// system made from an inquiry can learn that inquiry's e-mail domain, and once a person has
// edited the company, later inquiries from that domain naming no company join it. Nobody can
// see which domain it is (a keyed hash), so the drawer says one is held, and an Admin can
// forget it here: inquiries from that domain stop joining the company.
//
// `crm.settings` (Admin's: who joins which company is the CRM's configuration, owner item
// O-7), and the database asks for crm.settings and crm.contacts again, both live
// (public.crm_company_forget_domain, SECURITY INVOKER, plus a narrow definer that clears the
// one column no staff grant reaches). At the version the drawer read: 409 when it moved, 404
// for a company the caller does not see. Not an edit of the company (its version stays).
// Audited `crm.company.update` with the field name and whether there was one to forget, never
// a value.

export const prerender = false;

export const DELETE = defineAdminRoute({
  cap: 'crm.settings',
  input: CompanyForgetDomainSchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireCompanyId(params);
    const { data, error } = await sb.rpc('crm_company_forget_domain', {
      p_tenant: auth.tenantId,
      p_company: id,
      p_version: input.version,
    });
    if (error) throw companyError(error, "the company's domain", 'company', 'crm.settings');
    const company = pickCompany(data);
    if (!company) throw new NotFoundError('company');
    const forgot = (data as Record<string, unknown>)['forgot'] === true;
    audit({
      action: 'crm.company.update',
      entityType: 'company',
      entityId: id,
      detail: { fields: ['domain'], how: 'forgotten', forgot },
    });
    return { company, forgot };
  },
});
