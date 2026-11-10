import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { ContactLookupSchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { pick, tenantCountry, toRpcFilter } from '@/lib/crm/leadQuery';
import { CONTACT_LOOKUP_FIELDS, contactError } from '@/lib/crm/contacts';

// A picker's contact search (Admin v2 C6): at most 8 answers, each a name, a company and a
// stage, never an e-mail or a phone. `crm.contacts`; a POST (D10), the same filter and blind
// index rule as the list (public.crm_contacts_list as the caller), newest activity first.

export const prerender = false;

const LOOKUP_LIMIT = 8;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactLookupSchema,
  handler: async ({ auth, sb, input }) => {
    const filter = await toRpcFilter(
      LEAD_PII_ENC_KEY,
      auth.tenantId,
      { q: input.q, limit: LOOKUP_LIMIT, sort: 'recent' },
      tenantCountry(sb, auth.tenantId),
    );
    const { data, error } = await sb.rpc('crm_contacts_list', {
      p_tenant: auth.tenantId,
      p_filter: filter,
    });
    if (error) throw contactError(error, 'the contact search');
    const rows = (data as { rows?: unknown } | null)?.rows;
    return {
      contacts: (Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [])
        .slice(0, LOOKUP_LIMIT)
        .map((row) => pick(row, CONTACT_LOOKUP_FIELDS)),
    };
  },
});
