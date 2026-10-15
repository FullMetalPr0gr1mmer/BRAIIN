import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import type { BadgeTone } from '../tones';
import { count, list, readFailed, record } from '../stats/read';

// Field Core Web Vitals for site health (Admin v2 U2): what visitors' own browsers measured,
// read from rollup_daily_vitals through public.vitals_summary (migration 0052), never from
// the raw beacons (CLAUDE.md Pillar 4: dashboards read rollup_* only). Field data is the
// source of truth for INP (Pillar 2); the lab numbers (Lighthouse, TBT) run in CI.
//
// The rollup keeps, per day, how many samples fell in each fixed bucket. VITALS_EDGES is the
// buckets' upper edges, the same numbers as app.vitals_edges() in the migration
// (tests/lib/vitals.spec.ts holds them equal). The §6 budgets and web.dev's "poor"
// thresholds are edges, and a bucket holds the values above its lower edge up to and
// including its upper edge, so a range's p75 shown as its bucket's upper edge is rated
// exactly as the true p75 would be.

export const VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

/** The three CLAUDE.md §6 budgets the score and the checklist judge. */
export const BUDGETED: readonly VitalMetric[] = ['LCP', 'INP', 'CLS'];

/** 24 upper edges per metric (milliseconds; CLS unitless); a 25th bucket is open above. */
export const VITALS_EDGES: Readonly<Record<VitalMetric, readonly number[]>> = {
  LCP: [
    250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000,
    4500, 5000, 6000, 7000, 8000, 10000, 15000, 20000,
  ],
  INP: [
    25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 1000, 1250,
    1500, 2000, 3000, 5000, 10000,
  ],
  CLS: [
    0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.125, 0.15, 0.175, 0.2, 0.25, 0.3,
    0.4, 0.5, 0.6, 0.8, 1, 1.5, 2, 3,
  ],
  FCP: [
    200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800, 3000, 3500,
    4000, 5000, 6000, 8000, 10000, 15000, 20000, 30000,
  ],
  TTFB: [
    100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700,
    1800, 2000, 2500, 3000, 4000, 6000, 10000,
  ],
};

/** CLAUDE.md §6: LCP, INP and CLS are budgets; FCP and TTFB are shown, not judged. */
export const BUDGETS: Readonly<Record<VitalMetric, number>> = {
  LCP: 2500,
  INP: 200,
  CLS: 0.1,
  FCP: 1800,
  TTFB: 800,
};

/** web.dev's "poor": above these. Between the budget and this is "needs work". */
export const POOR: Readonly<Record<VitalMetric, number>> = {
  LCP: 4000,
  INP: 500,
  CLS: 0.25,
  FCP: 3000,
  TTFB: 1800,
};

export type Rating = 'good' | 'needs-work' | 'poor';

export const RATING_LABEL: Readonly<Record<Rating, string>> = {
  good: 'Good',
  'needs-work': 'Needs work',
  poor: 'Poor',
};

export const RATING_TONE: Readonly<Record<Rating, BadgeTone>> = {
  good: 'ok',
  'needs-work': 'warn',
  poor: 'err',
};

/** What each measure is, in plain words first. */
export const VITAL_NAMES: Readonly<Record<VitalMetric, string>> = {
  LCP: 'Largest paint (LCP)',
  INP: 'Response to a tap (INP)',
  CLS: 'Layout shift (CLS)',
  FCP: 'First paint (FCP)',
  TTFB: 'Server response (TTFB)',
};

/** Site health judges the last 28 days, as Chrome's field data does. */
export const HEALTH_WINDOW_DAYS = 28;

/** Fewer samples than this and a measure is not judged ("not enough visits yet"). */
export const MIN_SAMPLES = 50;

/** Good at or under the budget, poor above web.dev's threshold, needs work between. */
export function rate(metric: VitalMetric, p75: number): Rating {
  if (p75 <= BUDGETS[metric]) return 'good';
  if (p75 <= POOR[metric]) return 'needs-work';
  return 'poor';
}

const MS = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const SECONDS = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const SHIFT = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/** "1.8 s" for paints, "140 ms" for INP and TTFB, "0.02" for CLS; "over 20.0 s" when open. */
export function formatVital(metric: VitalMetric, value: number, open = false): string {
  const shown =
    metric === 'CLS'
      ? SHIFT.format(value)
      : metric === 'LCP' || metric === 'FCP'
        ? `${SECONDS.format(value / 1000)} s`
        : `${MS.format(value)} ms`;
  return open ? `over ${shown}` : shown;
}

export interface VitalRow {
  /** A page's path, or '*' for every page together. */
  path: string;
  metric: VitalMetric;
  samples: number;
  /** The 75th percentile: exact for one day, a bucket's upper edge over more (`approx`). */
  p75: number;
  approx: boolean;
  /** The 75th percentile is above the last edge: `p75` is that edge ("over"). */
  open: boolean;
}

export interface VitalsReport {
  days: number;
  /** The range's first UTC day. */
  from: string | null;
  /** When the rollup last changed, or null when it holds nothing for the range. */
  rolledUpAt: string | null;
  rows: VitalRow[];
}

const isMetric = (value: unknown): value is VitalMetric =>
  typeof value === 'string' && (VITAL_METRICS as readonly string[]).includes(value);

/** The last `days` UTC days (today included) of field vitals, per page and site-wide. */
export async function loadVitals(
  sb: SupabaseClient,
  auth: AuthContext,
  days: number = HEALTH_WINDOW_DAYS,
): Promise<VitalsReport> {
  const { data, error } = await sb.rpc('vitals_summary', { p_tenant: auth.tenantId, p_days: days });
  if (error) throw await readFailed('admin:health', 'Speed', error.message);
  const summary = record(data);
  const rows: VitalRow[] = [];
  for (const row of list(summary['rows'])) {
    const metric = row['metric'];
    const p75 = Number(row['p75']);
    if (!isMetric(metric) || !Number.isFinite(p75) || typeof row['path'] !== 'string') continue;
    rows.push({
      path: row['path'],
      metric,
      samples: count(row['samples']),
      p75,
      approx: row['approx'] === true,
      open: row['open'] === true,
    });
  }
  return {
    days,
    from: typeof summary['from'] === 'string' ? summary['from'] : null,
    rolledUpAt: typeof summary['rolled_up_at'] === 'string' ? summary['rolled_up_at'] : null,
    rows,
  };
}

/** The site-wide row for a measure ('*'), or null when nothing was measured. */
export function siteVital(report: VitalsReport, metric: VitalMetric): VitalRow | null {
  return report.rows.find((row) => row.path === '*' && row.metric === metric) ?? null;
}

/** A measure's rating, or null when it has fewer than MIN_SAMPLES samples to judge. */
export function judged(row: VitalRow | null): Rating | null {
  return row && row.samples >= MIN_SAMPLES ? rate(row.metric, row.p75) : null;
}

export interface SpeedRow {
  path: string;
  /** The most samples any of its measures has. */
  samples: number;
  vitals: Partial<Record<VitalMetric, VitalRow>>;
}

/** The Speed tab's rows: one per page, its three budgeted measures, the busiest first. */
export function speedRows(report: VitalsReport): SpeedRow[] {
  const byPath = new Map<string, SpeedRow>();
  for (const row of report.rows) {
    if (row.path === '*') continue;
    const entry = byPath.get(row.path) ?? { path: row.path, samples: 0, vitals: {} };
    entry.vitals[row.metric] = row;
    entry.samples = Math.max(entry.samples, row.samples);
    byPath.set(row.path, entry);
  }
  return [...byPath.values()].sort((a, b) => b.samples - a.samples || a.path.localeCompare(b.path));
}
