import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { writeSystemLog } from '@/lib/data/systemLog';
import { runApplicationRetention } from '@/lib/applications/retention';
import { runLeadIndexBackfill } from '@/lib/crm/indexBackfill';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';

// The Worker's daily cron (src/worker.ts `scheduled`, wrangler.jsonc `triggers.crons`).
// Counts only go to system_logs — never an applicant's name, path or address. A failed
// step is logged as an error so Site Health shows it; the next day's run retries it.
export async function runDailyJobs(): Promise<void> {
  if (!supabaseConfigured()) return;
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
  // arrived without them. Counts only.
  try {
    const run = await runLeadIndexBackfill(serviceClient(), LEAD_PII_ENC_KEY);
    if (run.scanned > 0) {
      await writeSystemLog({
        level: run.failed > 0 ? 'error' : 'info',
        source: 'cron:crm-index',
        message:
          run.failed > 0
            ? `lead indexing ran with ${run.failed} failed write(s)`
            : 'lead indexing ran',
        detail: { ...run },
      });
    }
  } catch (err) {
    await writeSystemLog({
      level: 'error',
      source: 'cron:crm-index',
      message: err instanceof Error ? err.message : 'lead indexing failed',
    });
  }

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
}

/** How long the privileged-op ledger keeps a row: two days (docs/retention.md). */
export const PRIVILEGED_OPS_KEEP_MS = 48 * 60 * 60 * 1000;
