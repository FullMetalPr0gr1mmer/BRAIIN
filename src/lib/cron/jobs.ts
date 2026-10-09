import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog, type SystemLogEntry } from '@/lib/data/systemLog';
import { runApplicationRetention } from '@/lib/applications/retention';
import {
  INDEX_BATCH,
  newIndexRun,
  runLeadIndexBackfill,
  type IndexRun,
} from '@/lib/crm/indexBackfill';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';

// The Worker's daily cron jobs, in the order src/lib/cron/daily.ts runs them. A new job is
// one entry here, at its place in the order; its work lives in its own feature's module, as
// the Join retention's and the lead indexing's do.
//
// Cheapest first, so a run that the Workers Free plan cuts short (owner item O-16: 10 ms of
// CPU and 50 subrequests per invocation) has still done the purges. Each job declares its
// `budget`: its worst case in subrequests, its own log lines included (a line costs two, the
// tenant lookup and the insert). tests/lib/dailyJobs.spec.ts runs every job at its worst
// against its budget and holds the sum under the 50: 35 today, at 20 leads a batch.
//
// Counts only go to system_logs — never an applicant's name, path or address, never a
// lead's details. A failed job is logged as an error so Site Health shows it; the next
// day's run retries it.

export interface CronJob {
  /** Its log lines carry `source: 'cron:<name>'`. */
  readonly name: string;
  /** What it does, as a log line says it: "<label> failed" when it throws a non-Error. */
  readonly label: string;
  /** Its worst case in subrequests, its own log lines included. */
  readonly budget: number;
  /**
   * The job. It logs what it did itself; when it throws, the runner logs the failure under
   * its name and the jobs after it still run.
   */
  readonly run: () => Promise<void>;
}

export const DAILY_JOBS: readonly CronJob[] = [
  {
    name: 'privileged-ops',
    label: 'privileged-ops purge',
    // The delete; a line only when it fails.
    budget: 1 + 2,
    run: purgePrivilegedOps,
  },
  {
    name: 'retention',
    label: 'join retention',
    // The expired rows, their CVs, the rows, the orphans, their CVs and the limiter's old
    // counters (src/lib/applications/retention.ts), then its line.
    budget: 6 + 2,
    run: retainApplications,
  },
  {
    name: 'crm-index',
    label: 'lead indexing',
    // The read, a country lookup (one tenant), one write per lead, then its line.
    budget: 2 + INDEX_BATCH + 2,
    run: indexLeads,
  },
];

// The privileged-op ledger (exports, lead reveals) only needs its last hour; keep two
// days for investigation and drop the rest. The audit log is the record, not this.
async function purgePrivilegedOps(): Promise<void> {
  const cutoff = new Date(Date.now() - PRIVILEGED_OPS_KEEP_MS).toISOString();
  const { error } = await serviceClient().from('privileged_ops').delete().lt('created_at', cutoff);
  if (error) throw new Error(error.message);
}

// The Join retention: expired CVs out of Storage, then their rows, then orphaned CVs and
// the public write limiter's old counters. One line, with the counts.
async function retainApplications(): Promise<void> {
  const run = await runApplicationRetention(serviceClient());
  await writeSystemLog({
    level: run.errors.length > 0 ? 'error' : 'info',
    source: 'cron:retention',
    message:
      run.errors.length > 0
        ? `join retention ran with errors (${run.errors.join(', ')})`
        : 'join retention ran',
    detail: { ...run },
  });
}

// CRM lead indexing (Admin v2 C1b): blind indexes, signals and scores for leads that
// arrived without them. The run object fills in as it goes, so a step that throws
// part-way is still logged with what it did: this job writes its line on every run.
async function indexLeads(): Promise<void> {
  const run = newIndexRun();
  let failure: string | null = null;
  try {
    await runLeadIndexBackfill(serviceClient(), LEAD_PII_ENC_KEY, INDEX_BATCH, run);
  } catch (err) {
    failure = err instanceof Error ? err.message : 'lead indexing failed';
  }
  await writeSystemLog(indexLogEntry(run, failure));
}

/** The lead-indexing line: counts and, when there was trouble, what kind. */
export function indexLogEntry(run: IndexRun, failure: string | null): SystemLogEntry {
  let message = 'lead indexing ran';
  if (failure !== null) message = `lead indexing failed after ${run.indexed} lead(s): ${failure}`;
  else if (run.stopped === 'key')
    message = `lead indexing stopped: the key decrypts none of the ${run.scanned} waiting lead(s), so nothing was written`;
  else if (run.failed > 0) message = `lead indexing ran with ${run.failed} failed write(s)`;
  return {
    level: message === 'lead indexing ran' ? 'info' : 'error',
    source: 'cron:crm-index',
    message,
    detail: { ...run },
  };
}

/** How long the privileged-op ledger keeps a row: two days (docs/retention.md). */
export const PRIVILEGED_OPS_KEEP_MS = 48 * 60 * 60 * 1000;
