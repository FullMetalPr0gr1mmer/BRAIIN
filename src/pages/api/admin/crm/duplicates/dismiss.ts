import { DuplicateDismissSchema } from '@schemas/crmMerge';
import { defineAdminRoute } from '@/lib/admin/route';
import { mergeError } from '@/lib/crm/merge';

// "Not a duplicate" (Admin v2 C12, crm.md §5.5): `crm.contacts`. The pair is not offered again.
// As the caller (public.crm_dismiss_duplicate, INVOKER): both must be live contacts the caller
// sees (a 404 otherwise, so another tenant's ids and merged records are unseen alike); RLS and
// the live check decide the write, and the row is put down to the session's person by the
// database. Saying it twice is not an error. Audited (the two ids only).

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  input: DuplicateDismissSchema,
  handler: async ({ auth, sb, input, audit }) => {
    const { data, error } = await sb.rpc('crm_dismiss_duplicate', {
      p_tenant: auth.tenantId,
      p_a: input.a,
      p_b: input.b,
    });
    if (error) throw mergeError(error, 'Not a duplicate');
    audit({
      action: 'crm.contact.duplicate_dismiss',
      entityType: 'contact',
      entityId: input.a,
      detail: { a: input.a, b: input.b, new: data === true },
    });
    return { dismissed: true };
  },
});
