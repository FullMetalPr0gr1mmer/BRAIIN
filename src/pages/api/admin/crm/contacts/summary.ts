import { ContactSummaryQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { contactError } from '@/lib/crm/contacts';

// The People screen's counts (Admin v2 C6): per stage, starred, the caller's own, expiring
// within 30 days, and contacts with a phone match to check. Counts only, never a contact.
// `crm.contacts`; runs as the caller (public.crm_contact_summary, INVOKER), for the caller's
// tenant, so a role without contacts learns nothing, not even the volume.

export const prerender = false;

const KEYS = [
  'total',
  'lead',
  'client',
  'past',
  'partner',
  'starred',
  'mine',
  'expiring',
  'to_check',
] as const;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactSummaryQuerySchema,
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb.rpc('crm_contact_summary', { p_tenant: auth.tenantId });
    if (error) throw contactError(error, 'the contact counts');
    const body = (data ?? {}) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const key of KEYS) out[key] = typeof body[key] === 'number' ? body[key] : 0;
    return out;
  },
});
