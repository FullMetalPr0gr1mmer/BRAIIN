import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { SearchHitSchema, type SearchHit } from '@schemas/search';
import type { Locale } from '@schemas/primitives';

// Runtime data access for unified search. Called only from the /api/search endpoint,
// never directly in indexable HTML (search results are noindex). RLS enforces tenant +
// published INSIDE the SECURITY INVOKER RPC. Resilient: returns [] on any error or
// before Supabase is provisioned — same contract as the other loaders.

export async function searchContent(q: string, locale: Locale): Promise<SearchHit[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient().rpc('search_content', { query: q, locale });
    if (error || !data) return [];
    return (data as unknown[]).flatMap((row) => {
      const parsed = SearchHitSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}

export async function searchSuggest(q: string, locale: Locale): Promise<SearchHit[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient().rpc('search_suggest', { query: q, locale });
    if (error || !data) return [];
    // search_suggest returns {…, similarity}; remap to the SearchHit shape (similarity →
    // rank, no snippet) so the endpoint renders primary hits and suggestions uniformly.
    return (data as Array<Record<string, unknown>>).flatMap((row) => {
      const parsed = SearchHitSchema.safeParse({
        entity_type: row.entity_type,
        slug: row.slug,
        title: row.title,
        snippet: null,
        rank: row.similarity,
      });
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}
