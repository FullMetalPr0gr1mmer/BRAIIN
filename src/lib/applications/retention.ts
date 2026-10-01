import type { SupabaseClient } from '@supabase/supabase-js';
import { removeCvs } from './storage';

// The daily retention job for the Join path, run by the Worker's cron trigger
// (wrangler.jsonc `triggers.crons`, src/worker.ts `scheduled`) — free on every Workers
// plan, and it needs no secret beyond the service-role key the Worker already holds.
//
// Why the Worker and not pg_cron: a CV is a Storage OBJECT, and deleting a row from
// `storage.objects` in SQL does not delete the file. Only the Storage API does, so the job
// that knows a row has expired must also be able to call that API.
//
// Order: the CV objects first, then the rows. If the object delete fails the rows stay, so
// tomorrow's run retries them; the reverse order would forget the file forever.
//
// Then the orphans: CV objects no row names (the Worker stopped between an upload and its
// insert, or a compensating delete failed). Retention works from rows, so without this
// sweep such a file would be kept forever. Only objects older than an hour — an upload
// whose insert is still in flight is never one.

/** How many expired applications one run handles (the rest wait a day). */
export const RETENTION_BATCH = 200;
/** Limiter counters older than this are dead weight (the longest window is a day). */
export const LIMITER_KEEP_HOURS = 48;
/** An object younger than this may belong to an application still being stored. */
export const ORPHAN_GRACE_MINUTES = 60;

export interface RetentionRun {
  applicationsDeleted: number;
  cvsDeleted: number;
  orphansDeleted: number;
  limiterRowsDeleted: number;
  errors: string[];
}

export async function runApplicationRetention(
  svc: SupabaseClient,
  now: Date = new Date(),
): Promise<RetentionRun> {
  const run: RetentionRun = {
    applicationsDeleted: 0,
    cvsDeleted: 0,
    orphansDeleted: 0,
    limiterRowsDeleted: 0,
    errors: [],
  };

  const { data, error } = await svc
    .from('job_applications')
    .select('id,cv_path')
    .lt('retention_delete_after', now.toISOString())
    .order('retention_delete_after', { ascending: true })
    .limit(RETENTION_BATCH);
  if (error) {
    run.errors.push('select-expired');
  } else {
    const rows = (data ?? []) as { id: string; cv_path: string | null }[];
    const paths = rows.map((r) => r.cv_path).filter((p): p is string => typeof p === 'string');
    if (rows.length > 0) {
      if (await removeCvs(svc, paths)) {
        run.cvsDeleted = paths.length;
        const { error: delError, count } = await svc
          .from('job_applications')
          .delete({ count: 'exact' })
          .in(
            'id',
            rows.map((r) => r.id),
          );
        if (delError) run.errors.push('delete-rows');
        else run.applicationsDeleted = count ?? rows.length;
      } else {
        run.errors.push('delete-objects');
      }
    }
  }

  const { data: orphans, error: orphanError } = await svc.rpc('application_orphan_cvs', {
    p_older_than_minutes: ORPHAN_GRACE_MINUTES,
    p_limit: RETENTION_BATCH,
  });
  if (orphanError) {
    run.errors.push('select-orphans');
  } else {
    const names = ((orphans ?? []) as { object_name?: unknown }[])
      .map((o) => o.object_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (names.length > 0) {
      if (await removeCvs(svc, names)) run.orphansDeleted = names.length;
      else run.errors.push('delete-orphans');
    }
  }

  const cutoff = new Date(now.getTime() - LIMITER_KEEP_HOURS * 3_600_000).toISOString();
  const { error: limError, count: limCount } = await svc
    .from('public_write_attempts')
    .delete({ count: 'exact' })
    .lt('window_start', cutoff);
  if (limError) run.errors.push('delete-limiter');
  else run.limiterRowsDeleted = limCount ?? 0;

  return run;
}
