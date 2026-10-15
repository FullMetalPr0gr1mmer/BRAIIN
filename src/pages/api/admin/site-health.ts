import { defineAdminRoute } from '@/lib/admin/route';
import { loadHealthReport } from '@/lib/admin/health/summary';
import {
  BUDGETED,
  BUDGETS,
  HEALTH_WINDOW_DAYS,
  judged,
  siteVital,
} from '@/lib/admin/health/vitals';

// Site health as JSON: the /admin/site-health screen's twin (Admin v2 U2) — `siteHealth.view`
// (Admin + Developer).
//
// FIELD data, the source of truth for INP (CLAUDE.md Pillar 2; the lab gate is the early
// warning, not the verdict), read from the vitals rollup (public.vitals_summary, migration
// 0052), never the raw beacons: the route used to scan up to 20,000 web_vitals rows in the
// Worker (Pillar 4: dashboards read rollup_* only) and PostgREST returned 1,000 of them.
// Over more than one day a p75 is the upper edge of its histogram bucket (`approx`); the
// budgets are bucket edges, so `withinBudget` is exact either way. The score, the tiles and
// the checklist are the screen's, gated as there by the caller's capabilities.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'siteHealth.view',
  handler: async ({ auth, sb }) => {
    const report = await loadHealthReport(sb, auth);
    const metrics = BUDGETED.map((metric) => {
      const row = report.vitals ? siteVital(report.vitals, metric) : null;
      return {
        metric,
        samples: row?.samples ?? 0,
        p75: row?.p75 ?? null,
        approx: row?.approx ?? false,
        budget: BUDGETS[metric],
        // `null` rather than false when there are too few visits to judge: unjudged is not
        // the same as over budget.
        withinBudget: judged(row) === null ? null : judged(row) === 'good',
      };
    });
    return {
      days: HEALTH_WINDOW_DAYS,
      rolledUpAt: report.vitals?.rolledUpAt ?? null,
      metrics,
      errorCount: report.errors7d ?? 0,
      score: report.score,
      scoreLabel: report.scoreLabel,
      tiles: report.tiles,
      checks: report.checks,
    };
  },
});
