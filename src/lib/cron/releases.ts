import { z } from 'zod';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';
import { COLLAPSE_TAG, purgeTags, type PurgeOptions, type PurgeOutcome } from '@/lib/http/purge';
import {
  RELEASE_PURGE_MAX_ATTEMPTS,
  purgeRetryAt,
  rebuildSnapshots,
  recordPurge,
} from '@/lib/release/afterEffects';
import type { CronJob } from './jobs';

// The Worker's minute schedule (`* * * * *`, src/lib/cron/schedules.ts; Admin v2 R7,
// docs/admin-v2/releases.md §4.7 and §5.3). What a published release still owes the edge:
//
//   • a purge that failed (a 429 on the Free plan's 5 purge requests a minute, a 5xx, the
//     breaker open, the day's 30,000 tags spent) and is due again: tried with backoff (1, 2,
//     4… minutes, at most 60, jittered) up to 10 attempts, then an error line and the
//     dashboard's `purge_failed` row (0066). The due releases' tags go in ONE request (more
//     than 30 together are `tenant:default`), so the minute stays within the Free plan's rate;
//   • a release whose after-effects never ran (the Worker stopped between the commit and
//     them: still `pending`, no attempt, two minutes after it went live): both edge snapshots
//     rebuilt as the system (the service client, the release's tenant, as the daily cron's
//     re-syncs) and the whole site purged (its items are not read again: `tenant:default`).
//
// The database is the source of truth and the lock: `public.claim_release_purges` (0103) takes
// the due releases of ONE tenant with SKIP LOCKED and pushes them five minutes ahead in the
// same statement, so two runs never act on one release twice, and a run that dies is retried
// when its lease ends. The outcome is recorded per release (`record_release_purge`, 0051).
//
// Scheduled releases are R11's: `apply_release` refuses `schedule` and `fire` until then, so
// nothing can be scheduled yet; R11 adds its fire step to this schedule.
//
// Releases are off for every tenant until R14 and no zone is set up (O-3): every minute is one
// claim that finds nothing, and nothing is logged.

/** Releases one run claims at most (0103's claim allows 1 to 20). */
export const RELEASE_CLAIM_LIMIT = 5;
/** A release still `pending` this long after it went live lost its after-effects (0103). */
export const RELEASE_ORPHAN_AFTER_MINUTES = 2;
/** How long a claim holds a release before another run may take it (0103). */
export const RELEASE_CLAIM_LEASE_MINUTES = 5;

/** One claimed release, as `claim_release_purges` answers it. */
export const ClaimedReleaseSchema = z.object({
  tenant_id: z.string().uuid(),
  release_id: z.string().uuid(),
  number: z.number().int().min(1),
  tags: z.array(z.string()),
  status: z.enum(['pending', 'failed']),
  attempts: z.number().int().min(0),
  orphan: z.boolean(),
});
export type ClaimedRelease = z.infer<typeof ClaimedReleaseSchema>;

export interface ReleaseCronRun {
  claimed: number;
  orphans: number;
  purge: PurgeOutcome['status'] | null;
  reason: string | null;
  /** Releases whose purge failed for the last time (attention `purge_failed`). */
  exhausted: number;
  /** Outcomes the release could not be told (`record_release_purge` failed). */
  unrecorded: number;
  kvSynced?: boolean;
}

/** The tags the claimed releases purge together: an orphan's or an empty set is everything. */
export function cronTags(claimed: readonly ClaimedRelease[]): string[] {
  if (claimed.some((c) => c.orphan || c.tags.length === 0)) return [COLLAPSE_TAG];
  return [...new Set(claimed.flatMap((c) => c.tags))];
}

/** One run: claim, rebuild what orphans owe, purge once, record each release, one line. */
export async function runReleasePurges(
  purge: Partial<Omit<PurgeOptions, 'source'>> = {},
): Promise<ReleaseCronRun> {
  const { data, error } = await serviceClient().rpc('claim_release_purges', {
    p_limit: RELEASE_CLAIM_LIMIT,
  });
  if (error) throw new Error(`claim_release_purges: ${error.message}`);
  const parsed = z.array(ClaimedReleaseSchema).safeParse(data ?? []);
  if (!parsed.success) throw new Error('claim_release_purges answered in the wrong shape');
  // The claim names one tenant; anything else waits for its own minute (the lease ends).
  const tenantId = parsed.data[0]?.tenant_id;
  const claimed = parsed.data.filter((c) => c.tenant_id === tenantId);
  const run: ReleaseCronRun = {
    claimed: claimed.length,
    orphans: claimed.filter((c) => c.orphan).length,
    purge: null,
    reason: null,
    exhausted: 0,
    unrecorded: 0,
  };
  if (!tenantId || claimed.length === 0) return run;

  const kvSynced =
    run.orphans > 0
      ? await rebuildSnapshots(tenantId, { redirects: true, visibility: true })
      : undefined;
  if (kvSynced !== undefined) run.kvSynced = kvSynced;

  const outcome = await purgeTags(tenantId, cronTags(claimed), { ...purge, source: 'cron' });
  run.purge = outcome.status;
  run.reason = outcome.reason ?? null;

  for (const release of claimed) {
    // record_release_purge counts every outcome but not_needed as an attempt.
    const attempts = release.attempts + (outcome.status === 'not_needed' ? 0 : 1);
    const nextAt =
      outcome.status === 'failed'
        ? purgeRetryAt(attempts, (purge.now ?? Date.now)(), purge.random ?? Math.random)
        : null;
    if (outcome.status === 'failed' && nextAt === null) run.exhausted += 1;
    const recorded = await recordPurge({
      tenantId,
      releaseId: release.release_id,
      status: outcome.status,
      // A failed release keeps the tags it owes; an orphan records what was sent for it.
      tags: release.orphan || release.tags.length === 0 ? outcome.tags : null,
      nextAt,
      sideEffects: release.orphan && kvSynced !== undefined ? { kvSynced } : {},
    });
    if (!recorded) run.unrecorded += 1;
  }

  await writeSystemLog({
    level: run.exhausted > 0 ? 'error' : outcome.status === 'failed' ? 'warn' : 'info',
    source: 'cron:releases',
    message:
      run.exhausted > 0
        ? `${run.exhausted} release purge(s) failed ${RELEASE_PURGE_MAX_ATTEMPTS} times and will not be retried`
        : outcome.status === 'failed'
          ? `release purge retry did not go through (${outcome.reason ?? 'unknown'}); it is tried again later`
          : 'release purges ran',
    detail: { ...run, tags: outcome.tags.length },
  });
  return run;
}

export const RELEASE_JOBS: readonly CronJob[] = [
  {
    name: 'releases',
    label: 'release purges',
    // The claim (1); an orphan's snapshots as the system: the redirect rules and their KV
    // write, the visibility rows, their KV write, the rows again and the write again (6), and a
    // line for each that fails (4); the budget read and the purge with one retry (3); one
    // record per release and a line for each that fails (5 + 10); the run's line (2): 31.
    budget: 1 + 6 + 4 + 3 + RELEASE_CLAIM_LIMIT * 3 + 2,
    run: async () => {
      await runReleasePurges();
    },
  },
];
