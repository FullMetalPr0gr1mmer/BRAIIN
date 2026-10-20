import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { ADMIN_TIME_ZONE } from '@/lib/admin/relTime';
import type { DateRange } from './range';
import { count, list, readError } from './read';

// The Audience tab's busiest hours (Admin v2 G1a): page views per hour of the day over the
// range, read from rollup_hourly_pageviews through public.busy_hours (migration 0071). The
// rollup counts whole UTC hours; the reader groups them by the local hour of the zone the
// Worker names, Riyadh by default (ADMIN_TIME_ZONE), so a studio time zone setting can
// replace the constant with no SQL change (the reader accepts 0035's allow-list).

const SOURCE = 'admin:stats';

/** Page views for each hour of the day, 0 to 23, in order. */
export type HourViews = readonly number[];

/** The reader's 24 rows as 24 numbers (an hour it leaves out is 0). */
export function hoursOf(raw: unknown): number[] {
  const out = Array.from({ length: 24 }, () => 0);
  for (const row of list(raw)) {
    const hour = Number(row['hour']);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) out[hour] = count(row['views']);
  }
  return out;
}

export async function loadBusyHours(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
  timeZone: string = ADMIN_TIME_ZONE,
): Promise<number[]> {
  const { data, error } = await sb.rpc('busy_hours', {
    p_tenant: auth.tenantId,
    p_from: range.from,
    p_to: range.to,
    p_tz: timeZone,
  });
  if (error) throw await readError(SOURCE, 'Busiest hours', error);
  return hoursOf(data);
}

/**
 * The busiest hours, most views first (ties by the earlier hour), only hours with views:
 * the chart draws them in the strong colour and the sentence under it names them.
 */
export function busiestHours(views: HourViews, take = 4): number[] {
  return views
    .map((value, hour) => ({ value, hour }))
    .filter((h) => h.value > 0)
    .sort((a, b) => b.value - a.value || a.hour - b.hour)
    .slice(0, take)
    .map((h) => h.hour);
}

/** "14:00": an hour of the day on the 24-hour clock. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
