import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { writeSystemLog, type SystemLogEntry } from '@/lib/data/systemLog';
import { runApplicationRetention } from '@/lib/applications/retention';
import {
  INDEX_BATCH,
  newIndexRun,
  runLeadIndexBackfill,
  type IndexRun,
} from '@/lib/crm/indexBackfill';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';

// The Worker's daily cron (src/worker.ts `scheduled`, wrangler.jsonc `triggers.crons`).
// Counts only go to system_logs — never an applicant's name, path or address, never a
// lead's details. A failed step is logged as an error so Site Health shows it; the next
// day's run retries it.
//
// Cheapest first, so a run that the Workers Free plan cuts short (owner item O-16: 10 ms of
// CPU and 50 subrequests per invocation) has still done the purges. Subrequests: the
// privileged-op purge 1 (and 2 for a failure line), the Join retention at most 6 and its
// line 2, the lead indexing 2 + INDEX_BATCH and its line 2: 35 of the 50 at 20 leads. The
// indexing line is written on every run, a partial one included.
export async function runDailyJobs(): Promise<void> {
  if (!supabaseConfigured()) return;

  // The privileged-op ledger (exports, lead reveals) only needs its last hour; keep two
  // days for investigation and drop the rest. The audit log is the record, not this.
  try {
    const cutoff = new Date(Date.now() - PRIVILEGED_OPS_KEEP_MS).toISOString();
    const { error } = await serviceClient()
      .from('privileged_ops')
      .delete()
      .lt('created_at', cutoff);
    if (error) throw new Error(error.message);
  } catch (err) {
    await writeSystemLog({
      level: 'error',
      source: 'cron:privileged-ops',
      message: err instanceof Error ? err.message : 'privileged-ops purge failed',
    });
  }

  try {
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
  } catch (err) {
    await writeSystemLog({
      level: 'error',
      source: 'cron:retention',
      message: err instanceof Error ? err.message : 'join retention failed',
    });
  }

  // CRM lead indexing (Admin v2 C1b): blind indexes, signals and scores for leads that
  // arrived without them. The run object fills in as it goes, so a step that throws
  // part-way is still logged with what it did.
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
