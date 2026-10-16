import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUDGETED,
  BUDGETS,
  MIN_SAMPLES,
  POOR,
  VITALS_EDGES,
  VITAL_METRICS,
  formatVital,
  judged,
  loadVitals,
  rate,
  speedRows,
  type VitalMetric,
  type VitalRow,
  type VitalsReport,
} from '@/lib/admin/health/vitals';
import type { AuthContext } from '@/lib/auth/types';
import type { SupabaseClient } from '@supabase/supabase-js';

// Field vitals (Admin v2 U2, src/lib/admin/health/vitals.ts): the bucket edges are the
// migration's, so a p75 shown as a bucket edge is rated as the true one would be; the
// ratings are the CLAUDE.md §6 budgets and web.dev's "poor" thresholds, "within budget"
// meaning at most the budget.

const MIGRATION = readFileSync('supabase/migrations/0052_stats_health_rollups.sql', 'utf8');

/** app.vitals_edges(metric) as the migration writes it. */
function sqlEdges(metric: VitalMetric): number[] {
  const body = /create or replace function app\.vitals_edges[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(
    MIGRATION,
  )?.[1];
  if (!body) throw new Error('no app.vitals_edges in 0052');
  const list = new RegExp(`when '${metric}' then array\\[([^\\]]*)\\]`).exec(body)?.[1];
  if (!list) throw new Error(`no edges for ${metric}`);
  return list.split(',').map((v) => Number(v.trim()));
}

describe('the bucket edges', () => {
  it.each([...VITAL_METRICS])('%s: the code holds the migration’s 24 edges', (metric) => {
    expect(VITALS_EDGES[metric]).toEqual(sqlEdges(metric));
    expect(VITALS_EDGES[metric]).toHaveLength(24);
  });

  it.each([...VITAL_METRICS])(
    '%s: rising, with the budget and the poor threshold as edges',
    (metric) => {
      const edges = VITALS_EDGES[metric];
      for (let i = 1; i < edges.length; i++) expect(edges[i]!).toBeGreaterThan(edges[i - 1]!);
      expect(edges).toContain(BUDGETS[metric]);
      expect(edges).toContain(POOR[metric]);
    },
  );

  it('the table holds 25 buckets, one more than the edges', () => {
    expect(MIGRATION).toMatch(/check \(cardinality\(hist\) = 25/);
  });

  it('the budgets are CLAUDE.md §6’s: LCP 2.5 s, INP 200 ms, CLS 0.1', () => {
    expect(BUDGETS.LCP).toBe(2500);
    expect(BUDGETS.INP).toBe(200);
    expect(BUDGETS.CLS).toBe(0.1);
    expect([...BUDGETED]).toEqual(['LCP', 'INP', 'CLS']);
    const standard = readFileSync('CLAUDE.md', 'utf8');
    expect(standard).toMatch(/\| LCP \| < 2\.5s \|/);
    expect(standard).toMatch(/\| INP \| < 200ms \|/);
    expect(standard).toMatch(/\| CLS \| < 0\.1 \|/);
  });
});

describe('rate', () => {
  const cases: [VitalMetric, number, string][] = [
    ['LCP', 2499, 'good'],
    ['LCP', 2500, 'good'],
    ['LCP', 2501, 'needs-work'],
    ['LCP', 4000, 'needs-work'],
    ['LCP', 4001, 'poor'],
    ['INP', 200, 'good'],
    ['INP', 201, 'needs-work'],
    ['INP', 500, 'needs-work'],
    ['INP', 501, 'poor'],
    ['CLS', 0.1, 'good'],
    ['CLS', 0.1001, 'needs-work'],
    ['CLS', 0.25, 'needs-work'],
    ['CLS', 0.26, 'poor'],
    ['FCP', 1800, 'good'],
    ['TTFB', 1801, 'poor'],
  ];
  it.each(cases)('%s at %s is %s', (metric, value, expected) => {
    expect(rate(metric, value)).toBe(expected);
  });

  it('a bucket edge is rated as every value inside its bucket would be', () => {
    // A bucket holds (previous edge, edge]: its upper edge and the values below it share a
    // rating, so a range's p75 shown as its bucket's upper edge is rated exactly.
    for (const metric of VITAL_METRICS) {
      const edges = VITALS_EDGES[metric];
      for (let i = 1; i < edges.length; i++) {
        const lower = edges[i - 1]!;
        const upper = edges[i]!;
        const inside = lower + (upper - lower) / 1000;
        expect(rate(metric, inside), `${metric} (${lower}, ${upper}]`).toBe(rate(metric, upper));
      }
    }
  });
});

describe('judged and formatted', () => {
  const row = (samples: number, p75 = 1000): VitalRow => ({
    path: '*',
    metric: 'LCP',
    samples,
    p75,
    approx: true,
    open: false,
  });

  it('a measure with too few visits is not judged', () => {
    expect(judged(null)).toBeNull();
    expect(judged(row(MIN_SAMPLES - 1))).toBeNull();
    expect(judged(row(MIN_SAMPLES))).toBe('good');
    expect(judged(row(MIN_SAMPLES, 5000))).toBe('poor');
  });

  it('says seconds for paints, milliseconds for INP and TTFB, a number for CLS', () => {
    expect(formatVital('LCP', 1840)).toBe('1.8 s');
    expect(formatVital('FCP', 900)).toBe('0.9 s');
    expect(formatVital('INP', 140)).toBe('140 ms');
    expect(formatVital('TTFB', 812.4)).toBe('812 ms');
    expect(formatVital('CLS', 0.02)).toBe('0.02');
    expect(formatVital('CLS', 0.125)).toBe('0.125');
    expect(formatVital('LCP', 20000, true)).toBe('over 20.0 s');
  });
});

describe('the Speed rows', () => {
  it('one per page, the busiest first, the site-wide row left out', () => {
    const report: VitalsReport = {
      days: 28,
      from: '2026-09-18',
      rolledUpAt: null,
      rows: [
        { path: '*', metric: 'LCP', samples: 90, p75: 2000, approx: true, open: false },
        { path: '/b', metric: 'LCP', samples: 10, p75: 3000, approx: true, open: false },
        { path: '/a', metric: 'LCP', samples: 60, p75: 1500, approx: true, open: false },
        { path: '/a', metric: 'CLS', samples: 70, p75: 0.05, approx: true, open: false },
      ],
    };
    const rows = speedRows(report);
    expect(rows.map((r) => r.path)).toEqual(['/a', '/b']);
    expect(rows[0]?.samples).toBe(70);
    expect(rows[0]?.vitals.CLS?.p75).toBe(0.05);
    expect(rows[1]?.vitals.CLS).toBeUndefined();
  });
});

describe('loadVitals', () => {
  const auth = { tenantId: 't1', role: 'admin' } as AuthContext;

  it('reads vitals_summary for the session tenant and keeps only well-formed rows', async () => {
    const calls: unknown[] = [];
    const sb = {
      rpc: async (fn: string, args: unknown) => {
        calls.push([fn, args]);
        return {
          data: {
            days: 28,
            from: '2026-09-18',
            rolled_up_at: '2026-10-15T00:07:00Z',
            rows: [
              { path: '*', metric: 'LCP', samples: 120, p75: 2500, approx: true, open: false },
              { path: '/x', metric: 'NOPE', samples: 1, p75: 1 },
              { path: '/y', metric: 'INP', samples: 3, p75: 'not a number' },
            ],
          },
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    const report = await loadVitals(sb, auth);
    expect(calls).toEqual([['vitals_summary', { p_tenant: 't1', p_days: 28 }]]);
    expect(report.rows).toEqual([
      { path: '*', metric: 'LCP', samples: 120, p75: 2500, approx: true, open: false },
    ]);
    expect(report.rolledUpAt).toBe('2026-10-15T00:07:00Z');
  });

  it('answers an empty report to a null answer (nothing measured)', async () => {
    const sb = { rpc: async () => ({ data: null, error: null }) } as unknown as SupabaseClient;
    const report = await loadVitals(sb, auth, 7);
    expect(report).toEqual({ days: 7, from: null, rolledUpAt: null, rows: [] });
  });
});
