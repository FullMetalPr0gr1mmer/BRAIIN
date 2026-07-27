import { AnalyticsQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';

// Analytics dashboard — `analytics.read`, which §5 grants to ALL FOUR roles.
//
// Reads `rollup_daily_pageviews` and never `analytics_events`. CLAUDE.md Pillar 4 is
// explicit ("Dashboards read rollup_* only"), and the reason is both cost and privacy:
// the raw table is monthly-partitioned and unbounded, so a dashboard scanning it turns
// every page view into a page-view-shaped query, and it carries session ids that a
// four-role audience has no reason to see.

export const prerender = false;

interface RollupRow {
  day: string;
  path: string;
  locale: string;
  views: number;
}

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  input: AnalyticsQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const since = new Date(Date.now() - input.days * 86_400_000).toISOString().slice(0, 10);

    let query = sb
      .from('rollup_daily_pageviews')
      .select('day,path,locale,views')
      .eq('tenant_id', auth.tenantId)
      .gte('day', since)
      .order('day', { ascending: true })
      .limit(5000);
    if (input.locale) query = query.eq('locale', input.locale);

    const { data, error } = await query;
    if (error) throw new Error(`analytics: ${error.message}`);
    const rows = (data ?? []) as RollupRow[];

    // Aggregated in the Worker rather than in SQL because these are pre-rolled daily
    // buckets — at most `days × paths × locales` rows — and doing it here keeps the
    // dashboard from needing its own database view per chart.
    const byDay = new Map<string, number>();
    const byPath = new Map<string, number>();
    const byLocale = new Map<string, number>();
    let total = 0;

    for (const row of rows) {
      total += row.views;
      byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.views);
      byPath.set(row.path, (byPath.get(row.path) ?? 0) + row.views);
      byLocale.set(row.locale, (byLocale.get(row.locale) ?? 0) + row.views);
    }

    const topPaths = [...byPath.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([path, views]) => ({ path, views }));

    return {
      days: input.days,
      total,
      series: [...byDay.entries()].map(([day, views]) => ({ day, views })),
      topPaths,
      byLocale: [...byLocale.entries()].map(([locale, views]) => ({ locale, views })),
    };
  },
});
