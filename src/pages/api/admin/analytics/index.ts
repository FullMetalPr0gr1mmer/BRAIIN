import { AnalyticsQuerySchema } from '@schemas/admin';
import { defineAdminRoute } from '@/lib/admin/route';
import { loadPageviewSummary } from '@/lib/admin/stats/pageviews';
import { rangeOfDays } from '@/lib/admin/stats/range';

// Website stats as JSON: the /admin/analytics screen's twin (Admin v2 U2) — `analytics.read`,
// which §5 grants to ALL FOUR roles.
//
// The rollup only (CLAUDE.md Pillar 4: "Dashboards read rollup_* only"), never the raw
// events, and added up in SQL (public.pageview_summary, migration 0052) through the same
// loader as the screen: the route used to read up to 5,000 rollup rows and PostgREST
// returned 1,000, so a long range came back short. `series` holds every day of the range,
// a day with no views as 0.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'analytics.read',
  input: AnalyticsQuerySchema,
  handler: async ({ auth, sb, input }) => {
    const summary = await loadPageviewSummary(
      sb,
      auth,
      rangeOfDays(input.days),
      input.locale ?? null,
    );
    const { current } = summary;
    return {
      days: input.days,
      total: current.total,
      series: current.byDay.map((d) => ({ day: d.day, views: d.en + d.ar })),
      topPaths: current.topPaths,
      byLocale: current.byLocale,
    };
  },
});
