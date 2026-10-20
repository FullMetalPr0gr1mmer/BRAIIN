import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  ApplyConflictDetailSchema,
  ApplyConflictSchema,
  ApplyRefusedDetailSchema,
  ApplyRequestSchema,
  ApplyResultSchema,
  DryRunReportSchema,
  type ApplyRequest,
  type PublishResult,
  type PurgeStatus,
  type ReleaseCheck,
  type ReleaseIssue,
} from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { syncRedirectsToEdge } from '@/lib/admin/redirectSync';
import { syncVisibilityToEdge } from '@/lib/admin/visibilitySync';
import { writeSystemLog } from '@/lib/data/systemLog';
import { serviceClient } from '@/lib/supabase/server';
import { ReleaseRefusal, type CheckedItem } from './validate';

// Calling `public.apply_release` (migration 0051, R4) for a checked selection, and what follows a
// publish (Admin v2 R6; docs/admin-v2/releases.md §4.2 steps 6 to 8, §4.3, §5.4). SERVER ONLY.
//
// The apply is SECURITY INVOKER with EXECUTE for the service role only: the Worker calls it with
// the service client, naming the publisher (`p_actor`, `p_role`); the function re-reads that
// person live and switches to them, so RLS, every RESTRICTIVE gate, CHECK and guard trigger
// binds as for them. Its time is the caller's to bound (R4's open item): PostgREST applies the
// function's own `statement_timeout` (20 s) to the transaction it opens, and the Worker stops
// waiting at APPLY_TIMEOUT_MS, a little later, and answers "busy".
//
// Its refusals come back as SQLSTATEs with JSON details, mapped here to the publish dialog's
// words: never the database's own message text (it can name columns and values; the kernel's
// rule, route.ts mapError), but the entity's named constraints and refusals where they say more.

type ApplyConflict = z.infer<typeof ApplyConflictSchema>;

/** How long the Worker waits for the apply (the function's own cap is 20 s). */
export const APPLY_TIMEOUT_MS = 25_000;

/** SQLSTATEs that mean "try again", never "refused" (R4 review 6). */
const BUSY = new Set(['55P03', '40P01', '40001', '57014']);

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
}

function parseDetail(details: unknown): unknown {
  if (typeof details !== 'string') return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

/** The apply's answer, or none: `unanswered` when the call ended without a response. */
interface ApplyAnswer {
  data: unknown;
  error: DbError | null;
  unanswered?: true;
}

/** The RPC call, bounded by the Worker's own timeout. */
async function callApply(args: ApplyRequest): Promise<ApplyAnswer> {
  const signal = AbortSignal.timeout(APPLY_TIMEOUT_MS);
  type Answer = { data: unknown; error: DbError | null; status?: number };
  const call = serviceClient().rpc('apply_release', args) as unknown as PromiseLike<Answer> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<Answer>;
  };
  let answer: Answer;
  try {
    answer = await (typeof call.abortSignal === 'function' ? call.abortSignal(signal) : call);
  } catch (err) {
    return unanswered(err instanceof Error ? err.message : 'apply_release did not answer');
  }
  // postgrest-js does not throw when the call is aborted or the connection drops: it resolves
  // with `status: 0` and an empty `code` (no response was read). Without this, an abort fell
  // through `refusalOf` to a 500 instead of the documented 503 busy.
  if (signal.aborted || answer.status === 0) {
    return unanswered(answer.error?.message ?? 'apply_release did not answer');
  }
  return { data: answer.data, error: answer.error };
}

/**
 * A timeout or a dropped connection: the transaction may still finish or roll back on its own;
 * the person is told to look again, never that it failed.
 */
function unanswered(message: string): ApplyAnswer {
  void writeSystemLog({ level: 'error', source: 'release:apply', message });
  return { data: null, error: { code: '57014', message: 'timeout' }, unanswered: true };
}

/** A busy database: 503 with a Retry-After, never "refused". */
function busy(): ReleaseRefusal {
  return new ReleaseRefusal(503, {
    ok: false,
    error: 'busy',
    detail: 'Someone else is publishing, or the site is busy. Try again in a moment.',
  });
}

/** The words for a change the database refused (the dry run's errors, a publish's BR422). */
export function dbIssue(
  err: {
    sqlstate: string;
    constraint: string | null;
    column: string | null;
    message: string;
  },
  item: CheckedItem | undefined,
): ReleaseIssue {
  const resource = item?.entry.resource;
  const named = err.constraint ? resource?.constraintFields?.[err.constraint] : undefined;
  if (named) {
    return named.field
      ? { code: 'refused', message: named.message, field: named.field }
      : { code: 'refused', message: named.message };
  }
  if (err.sqlstate === '42501') {
    const refusal = resource?.writeRefusals?.find((r) => r.match.test(err.message));
    if (refusal) {
      return refusal.field
        ? { code: 'refused', message: refusal.message, field: refusal.field }
        : { code: 'refused', message: refusal.message };
    }
    return { code: 'refused', message: 'Your role can’t make this change live.' };
  }
  const field = err.column && item ? fieldOfColumn(item, err.column) : undefined;
  const message =
    err.sqlstate === '23505'
      ? 'Something else on the site already uses this. Change it and try again.'
      : err.sqlstate === '23503'
        ? 'This points at something that is not on the site.'
        : err.sqlstate === '23514' || err.sqlstate === '23502'
          ? 'A rule of the site refuses this value.'
          : 'The site refused this change.';
  return field ? { code: 'refused', message, field } : { code: 'refused', message };
}

/** The payload key that writes a column (where the dialog shows the error). */
function fieldOfColumn(item: CheckedItem, column: string): string | undefined {
  for (const [key, columns] of Object.entries(item.entry.fields)) {
    if (columns.includes(column)) return key;
  }
  return undefined;
}

/** The report the endpoints answer. */
export function checkOf(items: readonly CheckedItem[], dryRun: 'ran' | 'skipped'): ReleaseCheck {
  const reports = items.map((i) => i.report);
  return {
    ok: reports.every((r) => r.errors.length === 0),
    items: reports,
    errors: [],
    dryRun,
  };
}

function requestOf(
  auth: AuthContext,
  mode: 'publish' | 'dry_run',
  items: readonly CheckedItem[],
  note: string | undefined,
): ApplyRequest {
  return ApplyRequestSchema.parse({
    p_actor: auth.userId,
    p_role: auth.role,
    p_mode: mode,
    p_items: items.map((i) => i.apply),
    p_note: note && note.length > 0 ? note : null,
    p_kind: 'publish',
  });
}

/** Lays the database's per-change refusals and conflicts onto the report. */
function absorb(
  check: ReleaseCheck,
  items: readonly CheckedItem[],
  errors: readonly {
    draftId: string | null;
    sqlstate: string;
    constraint: string | null;
    column: string | null;
    message: string;
  }[],
  conflicts: readonly ApplyConflict[],
): void {
  const byDraft = new Map(items.map((i) => [i.draft.id, i]));
  for (const err of errors) {
    const item = err.draftId ? byDraft.get(err.draftId) : undefined;
    const found = dbIssue(err, item);
    if (item) item.report.errors.push(found);
    else check.errors.push(found);
  }
  for (const conflict of conflicts) {
    const item = byDraft.get(conflict.draftId);
    if (!item) continue;
    item.report.conflict = conflict;
    item.report.errors.push(
      'removed' in conflict
        ? {
            code: 'removed',
            message: 'This item was removed on the live site. Discard the change.',
          }
        : {
            code: 'conflict',
            message:
              'Changed on the live site since this edit started. Keep yours or use the live version.',
          },
    );
  }
  check.ok = check.errors.length === 0 && items.every((i) => i.report.errors.length === 0);
}

/** Maps the apply's refusals that concern the whole request (both modes). */
function refusalOf(error: DbError, items: readonly CheckedItem[]): ReleaseRefusal {
  const code = error.code ?? '';
  if (BUSY.has(code)) return busy();
  if (code === 'BR403') {
    return new ReleaseRefusal(403, {
      ok: false,
      error: 'forbidden',
      capability: 'live-recheck',
      detail: 'Your account can’t publish right now. Sign in again, or ask an Admin.',
    });
  }
  if (code === '55000') {
    return new ReleaseRefusal(409, { ok: false, error: 'releases-off' });
  }
  if (code === 'BR409') {
    const detail = ApplyConflictDetailSchema.safeParse(parseDetail(error.details));
    if (detail.success && detail.data.code === 'pending-changed') {
      return new ReleaseRefusal(409, {
        ok: false,
        error: 'pending-changed',
        entity: 'content_draft',
        draftIds: detail.data.draftIds,
      });
    }
    if (detail.success && detail.data.code === 'conflict') {
      const check = checkOf(items, 'ran');
      absorb(check, items, [], detail.data.items);
      return new ReleaseRefusal(409, { ok: false, error: 'conflict', check });
    }
  }
  if (code === 'BR422') {
    const detail = ApplyRefusedDetailSchema.safeParse(parseDetail(error.details));
    if (detail.success) {
      const check = checkOf(items, 'ran');
      if (detail.data.code === 'refused') {
        absorb(check, items, detail.data.items, []);
      } else {
        const item = items.find((i) => i.draft.id === (detail.data as { draftId: string }).draftId);
        item?.report.errors.push({
          code: 'base-missing',
          message: 'This change was saved in an older way. Open it and save again.',
        });
        check.ok = false;
      }
      return new ReleaseRefusal(422, { ok: false, error: 'refused', check });
    }
  }
  // Anything else (22023 included: the Worker sent a shape the apply refuses) is a bug: a 500,
  // logged by the kernel with the message.
  throw new Error(`apply_release: ${code} ${error.message ?? ''}`.trim());
}

/** The database's dry run over a clean selection: its refusals and conflicts on the report. */
export async function dryRun(
  auth: AuthContext,
  items: readonly CheckedItem[],
  note: string | undefined,
): Promise<ReleaseCheck> {
  const check = checkOf(items, 'ran');
  const { data, error } = await callApply(requestOf(auth, 'dry_run', items, note));
  if (error) throw refusalOf(error, items);
  const report = DryRunReportSchema.safeParse(data);
  if (!report.success) throw new Error('apply_release (dry run) answered in the wrong shape');
  absorb(check, items, report.data.errors, report.data.conflicts);
  return check;
}

/** Publishes a clean selection, then the after-effects (never fatal). */
export async function publish(
  sb: SupabaseClient,
  auth: AuthContext,
  items: readonly CheckedItem[],
  note: string | undefined,
): Promise<PublishResult> {
  const answer = await callApply(requestOf(auth, 'publish', items, note));
  let data = answer.data;
  if (answer.error) {
    // No answer is not a refusal: the transaction may have committed after the Worker stopped
    // waiting. If it did, the after-effects still run (a release that hid a page must not leave
    // it public at the edge until the daily re-sync); if not yet, the person is told "busy".
    const landed = answer.unanswered ? await landedRelease(auth, items) : null;
    if (!landed) throw refusalOf(answer.error, items);
    data = landed;
  }
  const result = ApplyResultSchema.safeParse(data);
  if (!result.success) throw new Error('apply_release answered in the wrong shape');
  const { release_id: releaseId, number } = result.data;
  const effects = await afterPublish(sb, auth, releaseId, number, items);
  return {
    release: { id: releaseId, number },
    items: items.map((i) => ({
      entityType: i.draft.entity_type,
      entityId: i.draft.entity_id,
      op: i.draft.op,
    })),
    warnings: items.flatMap((i) =>
      i.report.warnings.map((w) => ({ draftId: i.draft.id, code: w.code, message: w.message })),
    ),
    purge: effects.purge,
    ...(effects.kvSynced === undefined ? {} : { kvSynced: effects.kvSynced }),
  };
}

/**
 * After an apply that did not answer: the release that claimed these drafts, if it committed.
 * Reads as the service role, scoped to the publisher's tenant and to the selected drafts' ids
 * (each draft is published at most once). Never throws: no answer here means "busy".
 */
async function landedRelease(
  auth: AuthContext,
  items: readonly CheckedItem[],
): Promise<{ release_id: string; number: number; items: [] } | null> {
  try {
    const svc = serviceClient();
    const { data: claimed, error } = await svc
      .from('content_release_items')
      .select('release_id')
      .eq('tenant_id', auth.tenantId)
      .in(
        'draft_id',
        items.map((i) => i.draft.id),
      )
      .limit(1)
      .maybeSingle();
    if (error || !claimed) return null;
    const { data: release, error: readError } = await svc
      .from('content_releases')
      .select('id, number')
      .eq('tenant_id', auth.tenantId)
      .eq('id', (claimed as { release_id: string }).release_id)
      .eq('status', 'published')
      .maybeSingle();
    const row = release as { id: string; number: number | null } | null;
    if (readError || !row || typeof row.number !== 'number') return null;
    void writeSystemLog({
      level: 'warn',
      source: 'release:apply',
      message: 'The apply committed after the Worker stopped waiting; after-effects run.',
      detail: { releaseId: row.id, number: row.number },
    });
    return { release_id: row.id, number: row.number, items: [] };
  } catch {
    return null;
  }
}

/**
 * After the commit, each effect on its own and never fatal (the `runHook` contract of
 * resource.ts: the release is live, so a failure here is reported, not thrown):
 *   • redirects in the release: the edge map rebuilt from the table (`syncRedirectsToEdge`,
 *     the publisher's RLS client, as a save does; publishing a redirect needs
 *     `redirects.manage`, so the publisher reads every rule);
 *   • page visibility in the release: the visibility snapshot rebuilt (`syncVisibilityToEdge`,
 *     the publisher's RLS client, which reads every rule: `page_visibility_read` is any staff
 *     role of the tenant, 0057). Only for a release carrying a visibility change, because only
 *     that change moves the snapshot; a page's new slug reaches the edge as it does for a save
 *     today, by the daily re-sync (R7 may run a rebuild as the system after a page release);
 *   • the cache purge: a logged no-op until a cache zone exists (owner item O-3, KAN-20; R7
 *     brings the purge seam), recorded on the release as `skipped`.
 */
async function afterPublish(
  sb: SupabaseClient,
  auth: AuthContext,
  releaseId: string,
  number: number,
  items: readonly CheckedItem[],
): Promise<{ purge: PurgeStatus; kvSynced?: boolean }> {
  const types = new Set(items.map((i) => i.draft.entity_type));
  let kvSynced: boolean | undefined;
  if (types.has('redirect')) {
    kvSynced = (await syncRedirectsToEdge(sb, auth)).kvSynced;
  }
  if (types.has('page_visibility')) {
    const synced = (await syncVisibilityToEdge(sb, auth)).kvSynced;
    kvSynced = (kvSynced ?? true) && synced;
  }

  const purge: PurgeStatus = 'skipped';
  void writeSystemLog({
    level: 'info',
    source: 'release:purge',
    message: 'No cache zone yet (KAN-20): nothing to purge.',
    detail: { releaseId, number },
  });
  try {
    const { error } = await serviceClient().rpc('record_release_purge', {
      p_tenant: auth.tenantId,
      p_release: releaseId,
      p_status: purge,
      p_tags: null,
      p_next_at: null,
      p_side_effects: kvSynced === undefined ? {} : { kvSynced },
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    void writeSystemLog({
      level: 'error',
      source: 'release:purge',
      message: err instanceof Error ? err.message : 'record_release_purge failed',
      detail: { releaseId },
    });
  }
  return kvSynced === undefined ? { purge } : { purge, kvSynced };
}
