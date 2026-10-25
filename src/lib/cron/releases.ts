import { z } from 'zod';
import {
  ApplyResultSchema,
  DraftOpSchema,
  FireApplyRequestSchema,
  FireSkippedSchema,
  PUBLISHER_ROLES,
  RELEASE_OVERDUE_MINUTES,
  ReleaseEntityTypeSchema,
  type PurgeStatus,
  type ReleaseFailureCode,
} from '@schemas/release';
import { serviceClient } from '@/lib/supabase/server';
import { writeSystemLog } from '@/lib/data/systemLog';
import { COLLAPSE_TAG, purgeTags, type PurgeOptions, type PurgeOutcome } from '@/lib/http/purge';
import {
  RELEASE_PURGE_MAX_ATTEMPTS,
  afterFire,
  purgeRetryAt,
  rebuildSnapshots,
  recordPurge,
} from '@/lib/release/afterEffects';
import { callApply, failureOf } from '@/lib/release/apply';
import { canPublish } from '@/lib/release/caps';
import type { CronJob } from './jobs';

// The Worker's minute schedule (`* * * * *`, src/lib/cron/schedules.ts; Admin v2 R7 and R11,
// docs/admin-v2/releases.md §4.7 and §5.3). Each minute is ONE of two things, so it stays within
// the Workers Free plan's 50 subrequests (P-15; RELEASE_MINUTE_BUDGET below):
//
// 1. A scheduled release that is due goes live (R11), one a minute, oldest first.
//    `public.claim_scheduled_releases` (0107) takes it with SKIP LOCKED and a two-minute lease,
//    so two runs never fire one release at once, and answers its scheduler's profile as it is
//    now and each change's type, operation and status. The Worker re-checks, against ROLE_CAPS,
//    that the scheduler is live and still publishes every change (its layer of the two), then
//    calls `apply_release` in `fire` mode as them: the same function and the same apply path a
//    publish takes, their live profile re-read, RLS bound as them, the release re-read under the
//    tenant's lock (one no longer scheduled, or moved later, is left alone: a second run is a
//    no-op). What a published release then owes the edge runs as the system (`afterFire`: the
//    snapshots, the purge, its record; R7's). A fire that cannot go live (the scheduler can no
//    longer publish, a conflict with live, a change the database refuses as them, releases off)
//    fails closed: `public.fail_scheduled_release` marks the release `failed` with a code and
//    releases its drafts, with an error line under `cron:releases`; the dashboard lists it
//    (`release_failed`, 0066) and the bell tells the roles that publish it
//    (src/lib/admin/notifications/releases.ts); one a person moved to a later time since the
//    claim is left as it is. A busy database (a lock wait, a deadlock, no answer) leaves it
//    scheduled, tried again once its lease ends. One that goes live more than
//    RELEASE_OVERDUE_MINUTES late logs a warning saying by how much. A minute that published a
//    release spends its subrequests on it; the purge retries below wait for the next minute.
//
// 2. Otherwise, what a published release still owes the edge (R7):
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
// Releases are off for every tenant until R14 and no zone is set up (O-3): no release can be
// scheduled (`apply_release` refuses a tenant whose releases are off), so every minute is two
// claims that find nothing, and nothing is logged.

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

// ---- A due scheduled release goes live (R11) -------------------------------------------------

/** How long the fire claim holds a release before another run may take it (0107). */
export const RELEASE_FIRE_LEASE_MINUTES = 2;
/** Scheduled releases one run fires at most (0107's claim allows 1 to 5). */
export const RELEASE_FIRE_LIMIT = 1;

/** One claimed scheduled release, as `claim_scheduled_releases` answers it. */
export const ClaimedScheduleSchema = z.object({
  tenant_id: z.string().uuid(),
  release_id: z.string().uuid(),
  scheduled_for: z.string(),
  scheduled_by: z.string().uuid().nullable(),
  kind: z.string(),
  scheduler: z
    .object({ role: z.string(), tenant_id: z.string().uuid(), live: z.boolean() })
    .nullable(),
  items: z.array(
    z.object({
      entity_type: ReleaseEntityTypeSchema,
      op: DraftOpSchema,
      status: z.string().nullable(),
    }),
  ),
});
export type ClaimedSchedule = z.infer<typeof ClaimedScheduleSchema>;

/** What a claimed release names at the least: its tenant and its id (to fail it). */
const ClaimedIdsSchema = z.object({ tenant_id: z.string().uuid(), release_id: z.string().uuid() });

export interface FireRun {
  /** What the minute did with the release it claimed; `none` when nothing was due. */
  outcome: 'none' | 'published' | 'skipped' | 'failed' | 'busy';
  releaseId?: string;
  number?: number;
  failure?: ReleaseFailureCode;
  purge?: PurgeStatus;
}

type PublisherRole = (typeof PUBLISHER_ROLES)[number];

const isPublisher = (role: string): role is PublisherRole =>
  (PUBLISHER_ROLES as readonly string[]).includes(role);

/**
 * The Worker's check before a fire (its layer of the two): the scheduler is live, of the
 * release's tenant, a publisher, and their role publishes every change the release holds
 * (`canPublish` from ROLE_CAPS). The role to fire as, or the failure.
 */
export function fireCheck(
  due: ClaimedSchedule,
): { role: PublisherRole } | { failure: ReleaseFailureCode } {
  const scheduler = due.scheduler;
  if (
    !due.scheduled_by ||
    !scheduler ||
    !scheduler.live ||
    scheduler.tenant_id !== due.tenant_id ||
    !isPublisher(scheduler.role)
  ) {
    return { failure: 'scheduler' };
  }
  const role = scheduler.role;
  const all = due.items.every((item) =>
    canPublish(role, {
      entityType: item.entity_type,
      op: item.op,
      patch: item.status === null ? null : { status: item.status },
    }),
  );
  return all && due.items.length > 0 ? { role } : { failure: 'forbidden' };
}

/** What `fail_scheduled_release` answers when it left the release as it was. */
const LeftAloneSchema = z.object({ failed: z.literal(false) });

/**
 * Fails the release closed, as the system, and says so in one line (no person, no value). The
 * database leaves a release that changed since the claim (it went live, failed or was cancelled,
 * or a person moved it to a later time): nothing failed, and the line says so.
 */
async function failRelease(
  due: Pick<ClaimedSchedule, 'tenant_id' | 'release_id'>,
  failure: ReleaseFailureCode,
  draftIds?: readonly string[],
): Promise<FireRun> {
  const { data, error } = await serviceClient().rpc('fail_scheduled_release', {
    p_tenant: due.tenant_id,
    p_release: due.release_id,
    p_code: failure,
    p_draft_ids: draftIds && draftIds.length > 0 ? [...draftIds] : null,
  });
  const leftAlone = !error && LeftAloneSchema.safeParse(data).success;
  await writeSystemLog({
    level: leftAlone ? 'info' : 'error',
    source: 'cron:releases',
    message: error
      ? `a scheduled release could not go live (${failure}) nor be marked failed; it is tried again`
      : leftAlone
        ? `a scheduled release could not go live (${failure}), but it changed meanwhile (moved, published or cancelled); it was left as it is`
        : `a scheduled release could not go live (${failure}); its changes are pending again`,
    detail: { releaseId: due.release_id, failure },
  });
  if (leftAlone) return { outcome: 'skipped', releaseId: due.release_id };
  return { outcome: 'failed', releaseId: due.release_id, failure };
}

/** One minute's fire: at most one due scheduled release, checked, fired, then its after-effects. */
export async function fireDueRelease(
  purge: Partial<Omit<PurgeOptions, 'source'>> = {},
): Promise<FireRun> {
  const { data, error } = await serviceClient().rpc('claim_scheduled_releases', {
    p_limit: RELEASE_FIRE_LIMIT,
  });
  if (error) throw new Error(`claim_scheduled_releases: ${error.message}`);
  const rows: unknown = data ?? [];
  if (!Array.isArray(rows)) throw new Error('claim_scheduled_releases answered in the wrong shape');
  if (rows.length === 0) return { outcome: 'none' };
  const parsed = ClaimedScheduleSchema.safeParse(rows[0]);
  if (!parsed.success) {
    // A release whose stored changes no longer read (a type this build does not know) can never
    // be checked: it fails closed now, rather than being claimed again at every lease's end.
    const ids = ClaimedIdsSchema.safeParse(rows[0]);
    if (!ids.success) throw new Error('claim_scheduled_releases answered in the wrong shape');
    return failRelease(ids.data, 'error');
  }
  const due = parsed.data;

  const check = fireCheck(due);
  if ('failure' in check) return failRelease(due, check.failure);

  const answer = await callApply(
    FireApplyRequestSchema.parse({
      p_actor: due.scheduled_by,
      p_role: check.role,
      p_mode: 'fire',
      p_items: null,
      p_release_id: due.release_id,
    }),
  );
  if (answer.error) {
    const failure = failureOf(answer.error);
    if (failure !== 'busy') return failRelease(due, failure.code, failure.draftIds);
    await writeSystemLog({
      level: 'warn',
      source: 'cron:releases',
      message:
        'a scheduled release did not go live this minute (the site was busy); it is tried again',
      detail: { releaseId: due.release_id },
    });
    return { outcome: 'busy', releaseId: due.release_id };
  }
  if (FireSkippedSchema.safeParse(answer.data).success) {
    return { outcome: 'skipped', releaseId: due.release_id };
  }
  // Live. Its after-effects as the system: the apply's own items give the tags and the
  // snapshots; an answer of another shape (it went live all the same) owes everything.
  const result = ApplyResultSchema.safeParse(answer.data);
  const number = result.success
    ? result.data.number
    : z.object({ number: z.number().int().min(1) }).safeParse(answer.data).data?.number;
  const effects = await afterFire({
    tenantId: due.tenant_id,
    releaseId: due.release_id,
    number: number ?? 0,
    items: result.success ? result.data.items : null,
    purge,
  });
  // Late past the dashboard's "overdue" (a cron outage, a busy database): the line is a warning
  // that says by how much (releases.md §4.6, `cron:releases`: fire failures and overdue releases).
  const late = (purge.now ?? Date.now)() - Date.parse(due.scheduled_for);
  const lateMinutes = late > RELEASE_OVERDUE_MINUTES * 60_000 ? Math.floor(late / 60_000) : null;
  await writeSystemLog({
    level: lateMinutes === null ? 'info' : 'warn',
    source: 'cron:releases',
    message:
      lateMinutes === null
        ? 'a scheduled release went live'
        : `a scheduled release went live ${lateMinutes} minutes late`,
    detail: {
      releaseId: due.release_id,
      number: number ?? null,
      items: due.items.length,
      purge: effects.purge,
      ...(lateMinutes === null ? {} : { lateMinutes }),
    },
  });
  const run: FireRun = { outcome: 'published', releaseId: due.release_id, purge: effects.purge };
  if (number !== undefined) run.number = number;
  return run;
}

// ---- The minute ------------------------------------------------------------------------------

/**
 * One minute: a due scheduled release first; when none went live, the purge retries. A fire
 * that throws (its claim failed) is logged, and the purges still run.
 */
export async function runReleaseMinute(
  purge: Partial<Omit<PurgeOptions, 'source'>> = {},
): Promise<{ fire: FireRun | null; purges: ReleaseCronRun | null }> {
  let fire: FireRun | null = null;
  try {
    fire = await fireDueRelease(purge);
  } catch (err) {
    await writeSystemLog({
      level: 'error',
      source: 'cron:releases',
      message: err instanceof Error ? err.message : 'the scheduled release claim failed',
    });
  }
  // A minute that published a release spent its subrequests on it (RELEASE_MINUTE_BUDGET).
  if (fire?.outcome === 'published') return { fire, purges: null };
  return { fire, purges: await runReleasePurges(purge) };
}

/**
 * R7's purge retries at their worst: the claim (1); an orphan's snapshots as the system, the
 * redirect rules and their KV write, the visibility rows, their KV write, the rows again and the
 * write again (6), and a line for each that fails (4); the budget read and the purge with one
 * retry (3); one record per release and a line for each that fails (5 + 10); the run's line
 * (2): 31.
 */
export const RELEASE_PURGE_BUDGET = 1 + 6 + 4 + 3 + RELEASE_CLAIM_LIMIT * 3 + 2;
/**
 * A fire that went live, at its worst: the claim and the apply (2); the snapshots as the system
 * (6) and a line for each that fails (4); the slugs its items do not carry, one read per table
 * of SLUG_TABLES (4); the purge's budget read, its request and one retry (3); its record, and a
 * line if that fails (3); the purge's own line (2); the run's line (2): 26. No purge retries run
 * that minute.
 */
export const RELEASE_FIRE_PUBLISHED_BUDGET = 2 + 6 + 4 + 4 + 3 + 3 + 2 + 2;
/**
 * A fire that did not go live, at its worst: the claim and the apply (2), then either the
 * failure and its line (3) or, for an apply that never answered, the apply's own line and the
 * run's "busy" line (4): 6.
 */
export const RELEASE_FIRE_FAILED_BUDGET = 2 + 4;
/**
 * The minute at its worst, each awaited call one subrequest and a log line two (the tenant lookup
 * and the insert): a fire that went live (26), a fire that did not and then the purge retries (6
 * + 31), or a fire claim that failed, its line, then the purge retries (3 + 31). 37, within the
 * Free plan's 50 (tests/lib/releaseCron.spec.ts measures each path).
 */
export const RELEASE_MINUTE_BUDGET = Math.max(
  RELEASE_FIRE_PUBLISHED_BUDGET,
  RELEASE_FIRE_FAILED_BUDGET + RELEASE_PURGE_BUDGET,
  1 + 2 + RELEASE_PURGE_BUDGET,
);

export const RELEASE_JOBS: readonly CronJob[] = [
  {
    name: 'releases',
    label: 'scheduled releases and release purges',
    budget: RELEASE_MINUTE_BUDGET,
    run: async () => {
      await runReleaseMinute();
    },
  },
];
