import { AnalyticsQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { loadSearchSummary } from '@/lib/admin/stats/search';

// Search analytics as JSON: the /admin/analytics/search screen's twin (Admin v2 U2) —
// `analytics.search` (Admin + SEO + Developer; NOT Content Creator, and search_queries' RLS
// says the same).
//
// The zero-result list is the useful half. CLAUDE.md §8 ties the Arabic FTS gate to
// "zero zero-result curated queries", and this is where real traffic tells you which
// uncurated queries are failing — each one is either a content gap or a tokenisation
// bug, and the two are distinguishable by whether the term is Arabic. Counted in SQL
// (public.search_summary, migration 0052): the route used to read 5,000 rows and got 1,000.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.search',
  input: AnalyticsQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const search = await loadSearchSummary(sb, auth, input.days, input.locale ?? null);
    return {
      days: input.days,
      totalSearches: search.total,
      zeroResultSearches: search.zeroTotal,
      topQueries: search.top,
      zeroResult: search.zero,
    };
  },
});
