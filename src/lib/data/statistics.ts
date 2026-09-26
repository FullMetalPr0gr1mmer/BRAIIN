import { StatisticRowSchema, type StatPlacement, type StatisticRow } from '@schemas/content';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { parseRows, reportLoadError } from './parse';

// Public stat counters (e.g. "150+ projects"). Tier A SSR reads under RLS
// (status='published', tenant-scoped). Shape lives in `packages/schemas/content.ts`
// (CLAUDE.md §8) — `value` stays a display string so authored suffixes survive verbatim.
//
// With a `placement`, only the counters shown on that page, each under that page's label
// (`placement_labels[placement]`, else `label`): the same number reads "Projects" on home
// and "Projects delivered across the region" on About.

export type { StatisticRow } from '@schemas/content';

const COLUMNS =
  'slug,label,value,sort_order,value_numeric,value_suffix,placements,placement_labels';

export async function getPublishedStatistics(
  opts: { placement?: StatPlacement } = {},
): Promise<StatisticRow[]> {
  if (!supabaseConfigured()) return [];
  try {
    let query = anonClient()
      .from('statistics')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (opts.placement) query = query.contains('placements', [opts.placement]);
    const { data, error } = await query;
    if (error) {
      reportLoadError('statistics', error);
      return [];
    }
    const rows = parseRows(StatisticRowSchema, data ?? [], 'statistic');
    const { placement } = opts;
    return placement
      ? rows.map((r) => ({ ...r, label: r.placement_labels[placement] ?? r.label }))
      : rows;
  } catch (err) {
    reportLoadError('statistics', err);
    return [];
  }
}
