import { CompanyQuerySchema } from '@schemas/crmCompanies';
import { defineAdminRoute } from '@/lib/admin/route';
import { companyFilter, readCompanyList } from '@/lib/crm/companies';

// The Companies tab (Admin v2 C11, crm.md §9): `crm.contacts` (crm.md §2.1, "contacts &
// companies"). A POST, so a search never sits in a URL, a log line or the browser history
// (verification D10). As the caller through public.crm_companies_list (SECURITY INVOKER): RLS,
// the live check and the column grants decide, the Worker names the tenant and the database
// refuses any other; the rows are cut to the named fields again here (never the domain
// index). A read, not audited: it reveals nothing gated (as the People list).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: CompanyQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const page = await readCompanyList(sb, auth.tenantId, companyFilter(input));
    return {
      rows: page.rows,
      total: page.total,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    };
  },
});
