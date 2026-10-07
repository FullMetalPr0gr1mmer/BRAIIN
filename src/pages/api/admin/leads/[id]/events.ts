import { z } from 'zod';
import { LeadEventsQuerySchema } from '@schemas/crm';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';

// A lead's timeline (Admin v2 C2b): `leads.manage`. Metadata only (stage keys, ids, a
// channel; never a note body or contact details), read as the caller: RLS and the live
// check decide (lead_events_live, 0034). Newest first, a page at a time, on the (at, id)
// keyset the rows are ordered by: one statement writes several events at the same instant
// (a stage move and a spam flag, say), so a page that ends inside such a group must pick up
// after its last EVENT, not after its instant. Pass the last event's `at` and `id` back as
// `before` and `beforeId`.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'leads.manage',
  input: LeadEventsQuerySchema,
  handler: async ({ auth, sb, input, params }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('lead');
    const limit = input.limit ?? 50;
    let query = sb
      .from('lead_events')
      .select('id,at,actor_id,kind,detail')
      .eq('tenant_id', auth.tenantId)
      .eq('lead_id', id)
      .order('at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (input.before !== undefined && input.beforeId !== undefined) {
      // Both values are schema-checked (an instant, a positive integer), and the instant is
      // quoted for PostgREST's filter syntax.
      query = query.or(
        `at.lt."${input.before}",and(at.eq."${input.before}",id.lt.${input.beforeId})`,
      );
    }
    const { data, error } = await query;
    if (error) throw new Error(`lead events: ${error.message}`);
    const events = (data ?? []) as { id: number; at: string }[];
    const last = events.length === limit ? events.at(-1) : undefined;
    return { events, before: last?.at ?? null, beforeId: last?.id ?? null };
  },
});
