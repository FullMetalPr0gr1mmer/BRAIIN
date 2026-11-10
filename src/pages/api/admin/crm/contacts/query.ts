import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { ContactQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { pick, tenantCountry, toRpcFilter } from '@/lib/crm/leadQuery';
import { CONTACT_LIST_FIELDS, contactError } from '@/lib/crm/contacts';

// The People list (Admin v2 C6): `crm.contacts`. A POST, so the search never sits in a URL,
// a log line or the browser history (verification D10). A whole e-mail or phone becomes its
// blind index here (src/lib/crm/leadQuery.ts toRpcFilter, the leads' own rule), so the
// address never reaches the database; one that only looks like an address is a 422. The
// filter runs as the caller through public.crm_contacts_list (SECURITY INVOKER, 0133) for the
// caller's tenant: RLS, the live check and the column grants decide, and the rows are cut to
// the safe fields again here (never a channel's value, its index or the custom values).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const filter = await toRpcFilter(
      LEAD_PII_ENC_KEY,
      auth.tenantId,
      input,
      tenantCountry(sb, auth.tenantId),
    );
    const { data, error } = await sb.rpc('crm_contacts_list', {
      p_tenant: auth.tenantId,
      p_filter: filter,
    });
    if (error) throw contactError(error, 'the contact list');
    const body = (data ?? {}) as { total?: unknown; rows?: unknown };
    const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];
    return {
      rows: rows.map((row) => pick(row, CONTACT_LIST_FIELDS)),
      total: typeof body.total === 'number' ? body.total : 0,
      limit: input.limit ?? 25,
      offset: input.offset ?? 0,
    };
  },
});
