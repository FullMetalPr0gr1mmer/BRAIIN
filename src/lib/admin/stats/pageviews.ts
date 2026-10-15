import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { PAGE_SIZE, offsetOf, pageInfo } from '../pager';
import { daysOf, hasPreviousPeriod, type DateRange } from './range';
import { count, list, readFailed, record } from './read';

// Page views for the stats screens (Admin v2 U2) and the dashboard's widgets (U1 imports
// these): read from rollup_daily_pageviews through the invoker RPCs of migration 0052, so
// the database adds them up and a long range is never cut at PostgREST's 1,000 rows (it
// was, while the routes read the rows themselves). The caller's RLS decides what is read
// (analytics.read, app.role_analytics_read); the tenant is the session's.

const SOURCE = 'admin:stats';

export interface DayViews {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  en: number;
  ar: number;
}

export interface LocaleViews {
  locale: string;
  views: number;
}

export interface PathViews {
  path: string;
  views: number;
}

export interface PageviewTotals {
  total: number;
  /** Every day of the range in order, a day with no views as zeros. */
  byDay: DayViews[];
  byLocale: LocaleViews[];
  /** The 20 busiest pages. */
  topPaths: PathViews[];
}

export interface PageviewSummary {
  range: DateRange;
  current: PageviewTotals;
  /** The same days just before, or null when the rollups do not reach back that far. */
  previous: PageviewTotals | null;
  /** The tenant's first rollup day: when counting started. */
  firstDay: string | null;
}

function totalsOf(raw: unknown, range: Pick<DateRange, 'from' | 'to'>): PageviewTotals {
  const data = record(raw);
  const seen = new Map<string, DayViews>();
  for (const row of list(data['by_day'])) {
    const day = typeof row['day'] === 'string' ? row['day'] : '';
    seen.set(day, { day, en: count(row['en']), ar: count(row['ar']) });
  }
  return {
    total: count(data['total']),
    byDay: daysOf(range).map((day) => seen.get(day) ?? { day, en: 0, ar: 0 }),
    byLocale: list(data['by_locale']).map((row) => ({
      locale: String(row['locale'] ?? ''),
      views: count(row['views']),
    })),
    topPaths: list(data['top_paths']).map((row) => ({
      path: String(row['path'] ?? ''),
      views: count(row['views']),
    })),
  };
}

/** The languages the rollup counts. */
export type StatLocale = 'en' | 'ar';

async function summaryOf(
  sb: SupabaseClient,
  auth: AuthContext,
  from: string,
  to: string,
  locale: StatLocale | null,
): Promise<unknown> {
  const { data, error } = await sb.rpc('pageview_summary', {
    p_tenant: auth.tenantId,
    p_from: from,
    p_to: to,
    p_locale: locale,
  });
  if (error) throw await readFailed(SOURCE, 'Page views', error.message);
  return data;
}

/**
 * The range's page views, and the previous period's when the rollups hold it (two reads
 * then, one otherwise). `locale` keeps one language (the JSON route's `?locale=`).
 */
export async function loadPageviewSummary(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
  locale: StatLocale | null = null,
): Promise<PageviewSummary> {
  const current = await summaryOf(sb, auth, range.from, range.to, locale);
  const first = record(current)['first_day'];
  const firstDay = typeof first === 'string' ? first : null;
  const previous = hasPreviousPeriod(firstDay, range)
    ? totalsOf(await summaryOf(sb, auth, range.prevFrom, range.prevTo, locale), {
        from: range.prevFrom,
        to: range.prevTo,
      })
    : null;
  return { range, current: totalsOf(current, range), previous, firstDay };
}

/** The share of page views in Arabic, in percent, or null with no views at all. */
export function arabicShare(byLocale: readonly LocaleViews[]): number | null {
  const total = byLocale.reduce((sum, row) => sum + row.views, 0);
  if (total <= 0) return null;
  const ar = byLocale.find((row) => row.locale === 'ar')?.views ?? 0;
  return (ar / total) * 100;
}

/** Each day's Arabic share in percent (0 on a day with no views): a KPI's spark. */
export function dailyArabicShare(byDay: readonly DayViews[]): number[] {
  return byDay.map((d) => (d.en + d.ar > 0 ? (d.ar / (d.en + d.ar)) * 100 : 0));
}

export interface PathRow {
  path: string;
  views: number;
  views_en: number;
  views_ar: number;
}

export interface PathPage {
  rows: PathRow[];
  /** Paths in the range. */
  total: number;
  /** The offset read: the URL's page, clamped to the last page there is. */
  offset: number;
}

async function pathsAt(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
  limit: number,
  offset: number,
): Promise<{ rows: PathRow[]; total: number }> {
  const { data, error } = await sb.rpc('pageview_paths', {
    p_tenant: auth.tenantId,
    p_from: range.from,
    p_to: range.to,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw await readFailed(SOURCE, 'Pages', error.message);
  const rows = list(data);
  return {
    rows: rows.map((row) => ({
      path: String(row['path'] ?? ''),
      views: count(row['views']),
      views_en: count(row['views_en']),
      views_ar: count(row['views_ar']),
    })),
    total: count(rows[0]?.['total_rows']),
  };
}

/**
 * One page of the range's paths, busiest first (`page` is 1-based). A page past the end
 * reads the last page instead, so the table never shows "51 to 60 of 60" over no rows.
 */
export async function loadPagePaths(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
  page: number,
): Promise<PathPage> {
  const offset = offsetOf(page);
  const first = await pathsAt(sb, auth, range, PAGE_SIZE, offset);
  if (first.rows.length > 0 || offset === 0) return { ...first, offset };
  // Past the end: learn the total, then read the last page.
  const probe = await pathsAt(sb, auth, range, 1, 0);
  if (probe.total === 0) return { rows: [], total: 0, offset: 0 };
  const last = pageInfo(probe.total, offset).offset;
  return { ...(await pathsAt(sb, auth, range, PAGE_SIZE, last)), offset: last };
}
