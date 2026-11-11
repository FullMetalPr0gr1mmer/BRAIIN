import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { MAX_QUERY_LENGTH, searchAdmin } from '@/lib/admin/globalSearch';

// The command palette's search (Admin v2 F3): a JSON wrapper around the same
// searchAdmin() that renders /admin/search, so the two can never disagree on what a role
// may find. That function does the gating: one ilike per entity the role can read,
// through the RLS-bound client, five hits per entity, and NEVER leads, contacts or job
// applications (personal data has its own pages and audit trail, not a search box).
//
// A POST, the term in its body (C7 review, C7-SEC-1): the palette asks on a 200 ms pause in
// typing, so whatever was in the box at a pause, half an e-mail address or the first digits
// of a phone number included, was put in a URL (the Worker's request logs, any proxy's)
// while it was a GET. A POST keeps every typed term out of every URL, for every role. There
// is no GET: the no-JS path is the /admin/search page, a form the person submits.
//
// `analytics.read` is the gate because it is the one capability every staff role holds:
// the endpoint is "any signed-in staff", and what each role finds is decided per entity.
// The client debounces at 200 ms and aborts stale requests; an over-long or control-
// character query is cleaned by searchAdmin, and Zod caps what is accepted at all.

export const prerender = false;

const SearchQuerySchema = z
  .object({
    q: z
      .string()
      .max(MAX_QUERY_LENGTH * 2)
      .default(''),
  })
  .strict();

export const POST = defineAdminRoute({
  cap: 'analytics.read',
  input: SearchQuerySchema,
  handler: async ({ auth, sb, input }) => searchAdmin(sb, auth, input.q),
});
