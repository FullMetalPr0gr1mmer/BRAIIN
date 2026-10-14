import { defineAdminRoute } from '@/lib/admin/route';
import { searchHelp } from '@/lib/admin/help';
import { HelpSearchQuerySchema } from '@schemas/help';

// GET /api/admin/help/search?q=: the help drawer's search (Admin v2 U16). The guides the
// caller's role may read that hold the words, in either language (public.help_search folds
// Arabic with app.normalize_ar_q on both sides, as CLAUDE.md §8's contains searches do, and
// treats `%` and `_` as characters), at most 20. The query
// is cleaned as the header search's is: control characters stripped, at most 64 characters.
// A guide's words are not personal data, so the query may travel in the URL (the header
// search's precedent); the lead routes keep theirs out of URLs because those can be addresses.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  input: HelpSearchQuerySchema,
  handler: async ({ auth, sb, input }) => ({ results: await searchHelp(sb, auth, input.q) }),
});
