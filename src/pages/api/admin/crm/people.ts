import { defineAdminRoute } from '@/lib/admin/route';

// The people a lead can be assigned to (Admin v2 C2a): the active lead workers of the
// caller's tenant, names and roles only, from public.crm_people(p_tenant) (a definer that
// checks the caller's live role itself, and that the tenant named is the token's).
// `leads.manage`.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb.rpc('crm_people', { p_tenant: auth.tenantId });
    if (error) throw new Error(`crm_people: ${error.message}`);
    const people = ((data ?? []) as Record<string, unknown>[]).map((person) => ({
      id: person['id'] ?? null,
      display_name: person['display_name'] ?? null,
      role: person['role'] ?? null,
    }));
    return { people };
  },
});
