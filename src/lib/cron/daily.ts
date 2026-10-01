import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { writeSystemLog } from '@/lib/data/systemLog';
import { runApplicationRetention } from '@/lib/applications/retention';

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
}
