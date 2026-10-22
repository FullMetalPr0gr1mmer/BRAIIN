import { writeSystemLog } from '@/lib/data/systemLog';
import { runJobs } from './daily';
import { HEALTH_JOBS } from './health';
import { DAILY_JOBS, type CronJob } from './jobs';
import { MAINTENANCE_RECONCILE_JOB } from './maintenanceReconcile';
import { RELEASE_JOBS } from './releases';

// The Worker's cron schedules (wrangler.jsonc `triggers.crons`), dispatched by
// src/worker.ts's `scheduled` on `controller.cron`. Each trigger is its own invocation, with
// its own Free-plan budget of 50 subrequests and 10 ms of CPU: tests/lib/cronSchedules.spec.ts
// holds these keys equal to wrangler.jsonc's crons and each schedule's declared budgets
// within 50.
//
// A new schedule is one line here and its cron in wrangler.jsonc (the account allows 5 cron
// triggers on the Free plan); a new job joins a schedule's list instead whenever the budget
// allows (Admin v2 U9b's maintenance reconcile joins the health schedule).

export const SCHEDULES: Readonly<Record<string, readonly CronJob[]>> = {
  // Daily at 03:23 UTC (06:23 in Riyadh): purges, retention, re-syncs, the lead indexing.
  '23 3 * * *': DAILY_JOBS,
  // Every 10 minutes: site health's readings (Admin v2 G2), then maintenance's reconcile
  // (Admin v2 U9b: "Back on" written to the row, the edge healed toward off).
  '*/10 * * * *': [...HEALTH_JOBS, MAINTENANCE_RECONCILE_JOB],
  // Every minute: what a published release still owes the edge (Admin v2 R7).
  '* * * * *': RELEASE_JOBS,
};

/** Runs the jobs of the schedule that fired. An unknown cron runs nothing and says so. */
export async function runSchedule(cron: string): Promise<void> {
  const jobs = Object.hasOwn(SCHEDULES, cron) ? SCHEDULES[cron] : undefined;
  if (!jobs) {
    await writeSystemLog({
      level: 'warn',
      source: 'cron',
      message: 'a cron trigger fired that no schedule names; nothing ran',
      detail: { cron: cron.slice(0, 40) },
    });
    return;
  }
  await runJobs(jobs);
}
