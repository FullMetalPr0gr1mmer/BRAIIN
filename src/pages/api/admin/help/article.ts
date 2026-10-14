import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { loadHelpArticle } from '@/lib/admin/help';
import { HelpArticleQuerySchema } from '@schemas/help';

// GET /api/admin/help/article?slug=: one guide to read, in both languages (Admin v2 U16).
// A 404 when the caller's tenant has no guide by that slug OR the caller's role may not read
// it: the two answers are the same, so the route does not say which guides exist for other
// roles. The slug is a query parameter, not a path segment, so a slug is validated by the
// same schema everywhere it arrives.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  input: HelpArticleQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const article = await loadHelpArticle(sb, auth, input.slug);
    if (!article) throw new NotFoundError('help guide');
    return { article };
  },
});
