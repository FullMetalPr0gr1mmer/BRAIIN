import { ContactTimelineQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { contactError, parseTimeline, requireContactId } from '@/lib/crm/contacts';

// A contact's timeline, a page at a time (Admin v2 C6, crm.md §9): `crm.contacts`. Read as
// the caller through public.crm_contact_timeline (SECURITY INVOKER, 0133): the contact's own
// events and those of its leads linked other than by phone, newest first, on one keyset
// (at, source, id), at most 60 a page, filtered to all, notes, leads or changes. Metadata
// only: never a note's words (the audited notes door) or a contact detail. A contact the
// caller cannot see is a 404. Pass `next` back as before, beforeSrc and beforeId. Audited
// `crm.contact.view` with `page` (queued: it reveals nothing gated).

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'crm.contacts',
  input: ContactTimelineQuerySchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = requireContactId(params);
    const filter: Record<string, unknown> = {};
    if (input.kind !== undefined) filter['kind'] = input.kind;
    if (input.limit !== undefined) filter['limit'] = input.limit;
    if (input.before !== undefined) {
      filter['before'] = input.before;
      filter['before_src'] = input.beforeSrc;
      filter['before_id'] = input.beforeId;
    }
    const { data, error } = await sb.rpc('crm_contact_timeline', {
      p_tenant: auth.tenantId,
      p_contact: id,
      p_filter: filter,
    });
    if (error) throw contactError(error, 'the contact timeline');
    audit({
      action: 'crm.contact.view',
      entityType: 'contact',
      entityId: id,
      detail: { page: input.before !== undefined ? 'more' : 'first', kind: input.kind ?? 'all' },
    });
    return parseTimeline(data);
  },
});
