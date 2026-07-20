import { StatisticRowSchema } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRows } from './parse';

// Public stat counters (e.g. "150+ projects"). Tier A SSR reads under RLS
// (status='published', tenant-scoped). Shape lives in `packages/schemas/content.ts`
// (CLAUDE.md §8) — `value` stays a display string so authored suffixes survive verbatim.

export type { StatisticRow } from '@schemas/content';

const COLUMNS = 'slug,label,value,sort_order';

export async function getPublishedStatistics() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('statistics')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(StatisticRowSchema, data, 'statistic');
  } catch {
    return [];
  }
}
