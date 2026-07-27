import { AnalyticsQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';

// Search analytics — `analytics.search` (Admin + SEO + Developer; NOT Content Creator).
//
// The zero-result list is the useful half. CLAUDE.md §8 ties the Arabic FTS gate to
// "zero zero-result curated queries", and this is where real traffic tells you which
// uncurated queries are failing — each one is either a content gap or a tokenisation
// bug, and the two are distinguishable by whether the term is Arabic.

export const prerender = false;

interface QueryRow {
  q: string;
  locale: string;
  results_count: number;
}

export const GET = defineAdminRoute({
  cap: 'analytics.search',
  input: AnalyticsQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const since = new Date(Date.now() - input.days * 86_400_000).toISOString();

    let query = sb
      .from('search_queries')
      .select('q,locale,results_count')
      .eq('tenant_id', auth.tenantId)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(5000);
    if (input.locale) query = query.eq('locale', input.locale);

    const { data, error } = await query;
    if (error) throw new Error(`search analytics: ${error.message}`);
    const rows = (data ?? []) as QueryRow[];

    const counts = new Map<string, { q: string; locale: string; hits: number; zero: number }>();
    for (const row of rows) {
      const key = `${row.locale}::${row.q}`;
      const entry = counts.get(key) ?? { q: row.q, locale: row.locale, hits: 0, zero: 0 };
      entry.hits += 1;
      if (row.results_count === 0) entry.zero += 1;
      counts.set(key, entry);
    }

    const all = [...counts.values()].sort((a, b) => b.hits - a.hits);
    return {
      days: input.days,
      totalSearches: rows.length,
      topQueries: all.slice(0, 50),
      zeroResult: all.filter((entry) => entry.zero > 0).slice(0, 50),
    };
  },
});
