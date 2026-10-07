import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { MAX_QUERY_LENGTH, searchAdmin } from '@/lib/admin/globalSearch';

// The command palette's search (Admin v2 F3): a JSON wrapper around the same
// searchAdmin() that renders /admin/search, so the two can never disagree on what a role
// may find. That function does the gating: one ilike per entity the role can read,
// through the RLS-bound client, five hits per entity, and NEVER leads, contacts or job
// applications (personal data has its own pages and audit trail, not a search box).
//
// `analytics.read` is the gate because it is the one capability every staff role holds:
// the endpoint is "any signed-in staff", and what each role finds is decided per entity.
// The client debounces at 200 ms and aborts stale requests; an over-long or control-
// character query is cleaned by searchAdmin, and Zod caps what is accepted at all.

export const prerender = false;

const SearchQuerySchema = z.object({
  q: z
    .string()
    .max(MAX_QUERY_LENGTH * 2)
    .default(''),
});

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  input: SearchQuerySchema,
  handler: async ({ auth, sb, input }) => searchAdmin(sb, auth, input.q),
});
