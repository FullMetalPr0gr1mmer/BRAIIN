import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { daysOf, hasPreviousPeriod, type DateRange } from './range';
import { count, list, readError, record } from './read';

// Visits for the stats screens (Admin v2 G1a): read from rollup_daily_visits through
// public.visit_summary (migration 0071), an invoker, so the caller's RLS decides
// (analytics.read). A visit is one session id on one UTC day: the id is per browser tab
// (src/lib/client/analytics.ts), so a tab kept open past midnight UTC counts again the next
// day. Events with no session id (storage blocked) are page views but in no visit.

const SOURCE = 'admin:stats';

export interface VisitTotals {
  visits: number;
  /** Visits with exactly one page view and nothing else (a bounce). */
  onePageVisits: number;
  /** Page views inside visits (pages per visit = visitViews / visits). */
  visitViews: number;
  /** Visits that opened a service page (the funnel's second step). */
  serviceVisits: number;
  /** Visits that opened a service page and then reached an inquiry form (its third). */
  serviceInquiryVisits: number;
  /** Visits that reached an inquiry form, with or without a service page. */
  inquiryVisits: number;
  /** Every day of the range in order, a day with no visits as 0. */
  byDay: { day: string; visits: number }[];
}

export interface VisitSummary {
  range: DateRange;
  current: VisitTotals;
  /** The same days just before, or null when the visits rollup does not reach back that far. */
  previous: VisitTotals | null;
  /** The tenant's first visits day: when counting visits started (0071's backfill). */
  firstDay: string | null;
}

/** The fields of visit_summary's answer, read leniently (a missing number is 0). */
export function visitTotalsOf(raw: unknown, range: Pick<DateRange, 'from' | 'to'>): VisitTotals {
  const data = record(raw);
  const seen = new Map<string, number>();
  for (const row of list(data['by_day'])) {
    if (typeof row['day'] === 'string') seen.set(row['day'], count(row['visits']));
  }
  return {
    visits: count(data['visits']),
    onePageVisits: count(data['one_page_visits']),
    visitViews: count(data['visit_views']),
    serviceVisits: count(data['service_visits']),
    serviceInquiryVisits: count(data['service_inquiry_visits']),
    inquiryVisits: count(data['inquiry_visits']),
    byDay: daysOf(range).map((day) => ({ day, visits: seen.get(day) ?? 0 })),
  };
}

async function summaryOf(
  sb: SupabaseClient,
  auth: AuthContext,
  from: string,
  to: string,
): Promise<unknown> {
  const { data, error } = await sb.rpc('visit_summary', {
    p_tenant: auth.tenantId,
    p_from: from,
    p_to: to,
  });
  if (error) throw await readError(SOURCE, 'Visits', error);
  return data;
}

/**
 * The range's visits, and the previous period's when the visits rollup holds it (two reads
 * then, one otherwise). The previous period is judged on this rollup's own first day, not
 * the page views', which started counting earlier. `previous: false` skips it (the
 * Conversions tab compares nothing).
 */
export async function loadVisitSummary(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
  options: { previous?: boolean } = {},
): Promise<VisitSummary> {
  const current = await summaryOf(sb, auth, range.from, range.to);
  const first = record(current)['first_day'];
  const firstDay = typeof first === 'string' ? first : null;
  const previous =
    options.previous !== false && hasPreviousPeriod(firstDay, range)
      ? visitTotalsOf(await summaryOf(sb, auth, range.prevFrom, range.prevTo), {
          from: range.prevFrom,
          to: range.prevTo,
        })
      : null;
  return { range, current: visitTotalsOf(current, range), previous, firstDay };
}

/** Page views per visit, to one decimal, or null with no visits. */
export function pagesPerVisit(totals: VisitTotals): number | null {
  if (!(totals.visits > 0)) return null;
  return Math.round((totals.visitViews / totals.visits) * 10) / 10;
}

/** The share of visits that saw one page and did nothing else, in percent, or null. */
export function onePageShare(totals: VisitTotals): number | null {
  if (!(totals.visits > 0)) return null;
  return (totals.onePageVisits / totals.visits) * 100;
}

export interface FunnelStep {
  label: string;
  visits: number;
}

/**
 * The views to inquiry funnel (G1 D4), each step a subset of the one before, in one visit:
 * visited, opened a service page, reached an inquiry form after it. The last step is the
 * visits that did both, so no step can be larger than the one above it.
 */
export function funnelSteps(totals: VisitTotals): FunnelStep[] {
  return [
    { label: 'Visited the site', visits: totals.visits },
    { label: 'Opened a service page', visits: totals.serviceVisits },
    { label: 'Reached an inquiry form', visits: totals.serviceInquiryVisits },
  ];
}

/** Visits that reached an inquiry form with no service page on the way (shown under it). */
export function inquiryWithoutService(totals: VisitTotals): number {
  return Math.max(0, totals.inquiryVisits - totals.serviceInquiryVisits);
}
