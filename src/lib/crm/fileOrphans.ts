import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';
import type { CronJob } from '@/lib/cron/jobs';
import { removeFileObjects } from './files';

// The contact-files sweep (Admin v2 C16), a job of the Worker's every-10-minutes schedule
// (src/lib/cron/schedules.ts; the daily schedule's budget is already the Free plan's 50). It
// removes objects in the private `crm-files` bucket that no row names:
//
//   • the files of a contact retention deleted (app.purge_crm, pg_cron): the rows go with the
//     contact by cascade, and SQL cannot delete a Storage object, so this follows within the
//     grace and ten minutes;
//   • an upload whose row was never written (the Worker stopped between the two, and its
//     compensating removal failed too), or a removal whose object outlived its row.
//
// public.crm_file_orphans (0140) finds them, as the service role only, in the Worker's own
// path shape only, and only objects older than the grace, so an upload whose row is still
// being written is never one. The Storage API removes them. A line only when it found
// something or failed, so a quiet bucket writes nothing 144 times a day; counts only, never a
// path (a path names a tenant and a contact).

/** How many objects one run removes at most (the rest wait ten minutes). */
export const CRM_FILE_ORPHAN_BATCH = 100;
/** An object younger than this may belong to an upload still being recorded. */
export const CRM_FILE_ORPHAN_GRACE_MINUTES = 60;

export interface CrmFileOrphanRun {
  found: number;
  removed: number;
  errors: string[];
}

export async function runCrmFileOrphanSweep(svc: SupabaseClient): Promise<CrmFileOrphanRun> {
  const run: CrmFileOrphanRun = { found: 0, removed: 0, errors: [] };
  const { data, error } = await svc.rpc('crm_file_orphans', {
    p_older_than_minutes: CRM_FILE_ORPHAN_GRACE_MINUTES,
    p_limit: CRM_FILE_ORPHAN_BATCH,
  });
  if (error) {
    run.errors.push('select-orphans');
    return run;
  }
  const names = ((data ?? []) as { object_name?: unknown }[])
    .map((row) => row.object_name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  run.found = names.length;
  if (names.length === 0) return run;
  if (await removeFileObjects(svc, names)) run.removed = names.length;
  else run.errors.push('delete-objects');
  return run;
}

async function sweep(): Promise<void> {
  const run = await runCrmFileOrphanSweep(serviceClient());
  if (run.found === 0 && run.errors.length === 0) return;
  await writeSystemLog({
    level: run.errors.length > 0 ? 'error' : 'info',
    source: 'cron:crm-file-orphans',
    message:
      run.errors.length > 0
        ? `contact files sweep ran with errors (${run.errors.join(', ')})`
        : 'contact files sweep ran',
    detail: { ...run },
  });
}

export const CRM_FILE_ORPHANS_JOB: CronJob = {
  name: 'crm-file-orphans',
  label: 'contact files sweep',
  // The orphans (one call), their removal (one call), then its line.
  budget: 1 + 1 + 2,
  run: sweep,
};
