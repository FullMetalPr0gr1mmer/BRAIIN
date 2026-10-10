import type { SupabaseClient } from '@supabase/supabase-js';
import { removeMediaObjects } from './storage';

// The daily sweep of the public `media` bucket (Admin v2 U3), one job of the Worker's cron
// (src/lib/cron/jobs.ts). It removes objects that no media row names:
//
//   • a replaced file's old object (the replace route writes a new key and leaves the old
//     one, so a page rendered just before the replace still finds its image until now);
//   • a deleted image whose own removal failed (the delete route keeps the row deleted and
//     says so in its audit row);
//   • an upload whose row was never written (the Worker stopped between the two, and its
//     compensating delete failed too).
//
// `public.media_orphan_objects()` (0045) finds them, as the service role only, and only
// objects older than the grace period, so an upload whose row is still being written is
// never one. The Storage API removes them: a SQL delete on storage.objects would leave the
// file. A batch a day; the rest wait for the next run.

/** How many objects one run removes at most. */
export const MEDIA_ORPHAN_BATCH = 100;
/** An object younger than this may belong to an upload still being recorded. */
export const MEDIA_ORPHAN_GRACE_MINUTES = 60;

export interface MediaOrphanRun {
  found: number;
  removed: number;
  errors: string[];
}

export async function runMediaOrphanSweep(svc: SupabaseClient): Promise<MediaOrphanRun> {
  const run: MediaOrphanRun = { found: 0, removed: 0, errors: [] };
  const { data, error } = await svc.rpc('media_orphan_objects', {
    p_older_than_minutes: MEDIA_ORPHAN_GRACE_MINUTES,
    p_limit: MEDIA_ORPHAN_BATCH,
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
  if (await removeMediaObjects(svc, names)) run.removed = names.length;
  else run.errors.push('delete-objects');
  return run;
}
