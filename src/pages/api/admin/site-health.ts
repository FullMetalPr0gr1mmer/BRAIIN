import { defineAdminRoute } from '@/lib/admin/route';
import { probeJson } from '@/lib/admin/health/probeJson';
import { loadHealthReport } from '@/lib/admin/health/summary';
import {
  BUDGETS,
  HEALTH_WINDOW_DAYS,
  VITAL_METRICS,
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
//
// The shape, against the pre-U2 route (no caller in the repository reads it but the authz
// cases, which check only the status):
//   days        always HEALTH_WINDOW_DAYS (28): `?days=` is no longer read, because the
//               score and the checklist are the screen's, judged over 28 days;
//   metrics     all five, as before ({metric, samples, p75, budget, withinBudget}), the
//               site-wide row. `p75` is exact for one day and otherwise the upper edge of its
//               histogram bucket, said by the new `approx`; `p95` is gone (a histogram gives
//               a bucket, not the percentile asked for). `withinBudget` is null when there
//               are too few visits to judge (MIN_SAMPLES), and exact otherwise: the budgets
//               are bucket edges. A metric nobody measured has samples 0 and p75 null;
//   samples     every site-wide sample of the five metrics, as before (the beacons counted);
//   errorCount  errors in the last 7 days (it followed `?days=`, 7 by default);
//   new         rolledUpAt, score, scoreLabel, tiles and checks: the screen's, gated as there
//               by the caller's capabilities;
//   G2          (additive) uptime, domain and certificate: each reading's state, checkedAt,
//               okAt and parsed facts (or null: never checked, or the readings could not be
//               read); score gains uptimePart, tiles the "Uptime, 30 days" tile, checks the
//               security.domain and security.certificate rows.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'siteHealth.view',
  handler: async ({ auth, sb }) => {
    const report = await loadHealthReport(sb, auth);
    const metrics = VITAL_METRICS.map((metric) => {
      const row = report.vitals ? siteVital(report.vitals, metric) : null;
      const rating = judged(row);
      return {
        metric,
        samples: row?.samples ?? 0,
        p75: row?.p75 ?? null,
        approx: row?.approx ?? false,
        budget: BUDGETS[metric],
        // `null` rather than false when there are too few visits to judge: unjudged is not
        // the same as over budget.
        withinBudget: rating === null ? null : rating === 'good',
      };
    });
    return {
      days: HEALTH_WINDOW_DAYS,
      rolledUpAt: report.vitals?.rolledUpAt ?? null,
      metrics,
      samples: metrics.reduce((sum, m) => sum + m.samples, 0),
      errorCount: report.errors7d ?? 0,
      score: report.score,
      scoreLabel: report.scoreLabel,
      tiles: report.tiles,
      checks: report.checks,
      uptime: probeJson(report.probes?.uptime ?? null),
      domain: probeJson(report.probes?.domain ?? null),
      certificate: probeJson(report.probes?.certificate ?? null),
    };
  },
});
