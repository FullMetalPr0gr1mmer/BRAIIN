import { z } from 'zod';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';

// Public stat counters (e.g. "150+ projects"). Tier A SSR reads under RLS
// (status='published', tenant-scoped), Zod-validated, resilient. `value` is a display
// string so it keeps suffixes like '+', '%', 'x' exactly as authored.

const LocalizedSchema = z.record(z.string(), z.string());

const StatisticRowSchema = z.object({
  slug: z.string(),
  label: LocalizedSchema,
  value: z.string(),
  sort_order: z.number(),
});
export type StatisticRow = z.infer<typeof StatisticRowSchema>;

const COLUMNS = 'slug,label,value,sort_order';

export async function getPublishedStatistics(): Promise<StatisticRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('statistics')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return data.flatMap((row) => {
      const parsed = StatisticRowSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    return [];
  }
}
