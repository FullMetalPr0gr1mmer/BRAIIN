import { supabaseConfigured } from '@/lib/supabase/client';
import { writeSystemLog } from '@/lib/data/systemLog';
import { DAILY_JOBS, type CronJob } from './jobs';

// The Worker's cron runner (src/worker.ts `scheduled` → src/lib/cron/schedules.ts, which
// picks the schedule that fired). It runs a schedule's jobs one after another, in their
// order: the daily ones (src/lib/cron/jobs.ts) cheapest first, each within its subrequest
// budget (that file has the sum).
//
// Each job is isolated. One that throws is logged as an error under its own name
// (`cron:<name>`, with the error's message and nothing else), so Site Health shows it and
// the next day's run retries it, and the jobs after it still run. What a job did is its own
// line: the lead indexing writes one on every run, a partial one included.
export async function runDailyJobs(jobs: readonly CronJob[] = DAILY_JOBS): Promise<void> {
  await runJobs(jobs);
}

/** Runs any schedule's jobs, each isolated as above. */
export async function runJobs(jobs: readonly CronJob[]): Promise<void> {
  if (!supabaseConfigured()) return;
  for (const job of jobs) {
    try {
      await job.run();
    } catch (err) {
      await writeSystemLog({
        level: 'error',
        source: `cron:${job.name}`,
        message: err instanceof Error ? err.message : `${job.label} failed`,
      });
    }
  }
}
