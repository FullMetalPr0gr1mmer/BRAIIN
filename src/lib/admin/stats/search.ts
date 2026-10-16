import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import type { StatLocale } from './pageviews';
import { count, list, readError, record } from './read';

// What visitors searched for (Admin v2 U2, the Search tab: analytics.search, Admin, SEO and
// Developer). One read of public.search_summary (migration 0052), which counts the searches
// in SQL: the route used to read up to 5,000 rows of search_queries and got 1,000. The zero
// result list is the useful half: each search that found nothing is a page worth writing or
// an Arabic tokenisation gap (CLAUDE.md §8, the FTS gate).

export interface SearchRow {
  q: string;
  locale: string;
  /** Times it was searched. */
  hits: number;
  /** Of those, how many found nothing. */
  zero: number;
}

export interface SearchSummary {
  days: number;
  /** Every search in the range. */
  total: number;
  /** Of those, how many found nothing. */
  zeroTotal: number;
  /** The 50 most frequent searches. */
  top: SearchRow[];
  /** The 50 that found nothing most often. */
  zero: SearchRow[];
}

const rowsOf = (value: unknown): SearchRow[] =>
  list(value).map((row) => ({
    q: String(row['q'] ?? ''),
    locale: String(row['locale'] ?? ''),
    hits: count(row['hits']),
    zero: count(row['zero']),
  }));

export async function loadSearchSummary(
  sb: SupabaseClient,
  auth: AuthContext,
  days: number,
  locale: StatLocale | null = null,
): Promise<SearchSummary> {
  const { data, error } = await sb.rpc('search_summary', {
    p_tenant: auth.tenantId,
    p_days: days,
    p_locale: locale,
  });
  if (error) throw await readError('admin:stats', 'Searches', error);
  const summary = record(data);
  return {
    days,
    total: count(summary['total']),
    zeroTotal: count(summary['zero_total']),
    top: rowsOf(summary['top']),
    zero: rowsOf(summary['zero']),
  };
}
