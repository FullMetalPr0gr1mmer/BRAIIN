import { defineAdminRoute } from '@/lib/admin/route';

// Site Health & Performance panel — `siteHealth.view` (Admin + Developer).
//
// Reads `web_vitals`, which is FIELD data. CLAUDE.md Pillar 2 names field RUM as the
// source of truth for INP specifically because lab numbers (Lighthouse/TBT) are a proxy
// that a fast CI machine flatters. The p75s below are what the budget is actually
// measured against; the CI gate is the early warning, not the verdict.

export const prerender = false;

/** CLAUDE.md §6. Kept here so the panel can colour a metric without a round-trip. */
const BUDGETS: Record<string, number> = { LCP: 2500, INP: 200, CLS: 0.1, TTFB: 800, FCP: 1800 };

interface VitalRow {
  metric: string;
  value: number;
  path: string | null;
}

export const GET = defineAdminRoute({
  cap: 'siteHealth.view',
  handler: async ({ auth, sb, url }) => {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? '7'), 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data, error } = await sb
      .from('web_vitals')
      .select('metric,value,path')
      .eq('tenant_id', auth.tenantId)
      .gte('occurred_at', since)
      .limit(20_000);
    if (error) throw new Error(`site health: ${error.message}`);
    const rows = (data ?? []) as VitalRow[];

    const grouped = new Map<string, number[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.metric) ?? [];
      bucket.push(row.value);
      grouped.set(row.metric, bucket);
    }

    const metrics = [...grouped.entries()].map(([metric, values]) => {
      const p75 = percentile(values, 75);
      const budget = BUDGETS[metric];
      return {
        metric,
        samples: values.length,
        p75,
        p95: percentile(values, 95),
        budget: budget ?? null,
        // `null` rather than `true` when there is no budget for this metric — an
        // unbudgeted metric is not the same as a passing one.
        withinBudget: budget === undefined ? null : p75 <= budget,
      };
    });

    const { count: errorCount } = await sb
      .from('system_logs')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', auth.tenantId)
      .eq('level', 'error')
      .gte('created_at', since);

    return { days, metrics, samples: rows.length, errorCount: errorCount ?? 0 };
  },
});

/** Nearest-rank percentile. Exact for the sample sizes a RUM panel deals in. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}
