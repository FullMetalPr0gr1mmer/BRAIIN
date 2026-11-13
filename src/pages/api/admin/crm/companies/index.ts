import { CompanyCreateSchema } from '@schemas/crmCompanies';
import { defineAdminRoute } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { companyBody, companyError, pickCompany } from '@/lib/crm/companies';

// A new company (Admin v2 C11, crm.md §9): `crm.contacts`. Immediate (P-3: CRM data is never
// staged into a release). As the caller through public.crm_company_create (SECURITY INVOKER):
// RLS, the live check, the insert guard, the owner rule and the composite keys (the sector,
// the client and the owner of the caller's own tenant) decide. Linking a public client row
// publishes nothing: clients.visible stays portfolio's switch. Audited `crm.company.create`
// with the field names chosen, never their values.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: CompanyCreateSchema,
  handler: async ({ auth, sb, input, audit }) => {
    const { data, error } = await sb.rpc('crm_company_create', {
      p_tenant: auth.tenantId,
      p_company: companyBody(input),
    });
    if (error) throw companyError(error, 'the new company');
    const company = pickCompany(data);
    if (!company) throw new ValidationError('the new company was refused');
    audit({
      action: 'crm.company.create',
      entityType: 'company',
      entityId: company.id,
      detail: {
        fields: Object.keys(input)
          .filter((key) => input[key as keyof typeof input] !== undefined)
          .sort(),
      },
    });
    return company;
  },
});
