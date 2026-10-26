import type { SupabaseClient } from '@supabase/supabase-js';
import {
  RELEASE_MAX_ITEMS,
  RELEASE_SCHEDULE_MAX_DAYS,
  RELEASE_SCHEDULE_MIN_MINUTES,
  type PublishRequest,
} from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { checkOf, dryRun, publish, schedule } from './apply';
import { untouchedRestore, type StoredDraft } from './drafts';
import {
  assertMayPublish,
  checkSelection,
  loadSelection,
  readLive,
  ReleaseRefusal,
} from './validate';

// The publish and validate endpoints' one handler (Admin v2 R6; docs/admin-v2/releases.md §4.2,
// §4.3). SERVER ONLY. The routes are `src/pages/api/admin/releases/index.ts` (publish now) and
// `validate.ts` (the check and the database's dry run); both take a PublishRequest (at most 60
// changes, a note of at most 280 characters, owner item O-4 and P-15). Per-area publish with
// every item ticked is the dialog's default (R12): the server publishes exactly the selection.
//
// Releases off (every tenant until R14): both answer 409 `releases-off` and read nothing more,
// so nothing here changes what any save does today.
//
// A rollback (R10, `kind: 'rollback'`) publishes the changes a restore staged, and only as the
// restore left them: every selected change carries the restore's mark for one version
// (`origin_kind`, `origin_release_id`, which only the restore path writes), none was edited
// since (an edited one no longer holds the version), and the selection is every open change of
// that version's restore (a part of it would leave the site between two versions). The release
// then names that version (`restores_release_id`) with the default note "Restored vN".
// Anything else is 422 on `kind`; the same changes can still be published as a plain release.
//
// A schedule (R11, `scheduleAt`, releases.md §4.7) is the same request with a time: at least two
// minutes ahead, at most 366 days (else 422 on `scheduleAt`), never a rollback (422 on `kind`: a
// restored version goes live when it is published). It runs every step of a publish, then
// `apply_release` in `schedule` mode, which dry-runs the changes as the person and stores them on
// a scheduled release with their drafts claimed. Validate takes the time too, and checks it.

type Ctx = AdminRouteContext<PublishRequest>;

export const RELEASES_OFF_DETAIL = 'Publishing is switched off: every save goes live at once.';

export const SCHEDULE_COPY = {
  tooSoon: `Choose a time at least ${RELEASE_SCHEDULE_MIN_MINUTES} minutes from now.`,
  tooLate: 'Choose a time within the next year.',
  rollback: 'A restored version goes live when you publish it. It can’t be scheduled.',
} as const;

/** The 422 for a time outside the bounds, or null when it is fine (`now` in ms). */
export function scheduleTimeRefusal(scheduleAt: string, now: number): ReleaseRefusal | null {
  const at = Date.parse(scheduleAt);
  const refuse = (detail: string) =>
    new ReleaseRefusal(422, { ok: false, error: 'validation', field: 'scheduleAt', detail });
  if (!Number.isFinite(at) || at < now + RELEASE_SCHEDULE_MIN_MINUTES * 60_000) {
    return refuse(SCHEDULE_COPY.tooSoon);
  }
  if (at > now + RELEASE_SCHEDULE_MAX_DAYS * 86_400_000) return refuse(SCHEDULE_COPY.tooLate);
  return null;
}

/** A refusal as its response (a busy database adds Retry-After). */
function answer(refusal: ReleaseRefusal): Response {
  const response = json(refusal.body, refusal.status);
  if (refusal.status === 503) response.headers.set('retry-after', '5');
  return response;
}

export async function handleRelease(ctx: Ctx, mode: 'validate' | 'publish'): Promise<unknown> {
  const { auth, sb, input } = ctx;
  try {
    if (!(await ctx.releasesEnabled())) {
      return json({ ok: false, error: 'releases-off', detail: RELEASES_OFF_DETAIL }, 409);
    }
    if (input.scheduleAt !== undefined) {
      if (input.kind === 'rollback') {
        throw new ReleaseRefusal(422, {
          ok: false,
          error: 'validation',
          field: 'kind',
          detail: SCHEDULE_COPY.rollback,
        });
      }
      const late = scheduleTimeRefusal(input.scheduleAt, Date.now());
      if (late) throw late;
    }
    const drafts = await loadSelection(sb, auth, input.items);
    const rollback = input.kind === 'rollback' ? await rollbackOf(sb, auth, drafts) : null;
    // The live rows, read once: who may publish a change to a row that stays archived is
    // live's to say (hotfix H12), and the check below lays the selection over the same rows.
    const live = await readLive(sb, auth, drafts);
    assertMayPublish(auth, drafts, live);
    // The person, re-read at the moment it runs: a demoted, deactivated or locked person's
    // token still passes RLS for up to an hour (the apply re-reads them again, BR403).
    await liveRecheck(auth);
    const checked = await checkSelection(sb, auth, drafts, live);
    if (!checked.ok) {
      const check = checkOf(checked.items, 'skipped');
      return mode === 'validate' ? check : json({ ok: false, error: 'validation', check }, 422);
    }
    const note = input.note || (rollback ? `Restored v${rollback.number}` : undefined);
    if (mode === 'validate') return await dryRun(auth, checked.items, note, rollback?.id);
    if (input.scheduleAt !== undefined) {
      return await schedule(auth, checked.items, note, input.scheduleAt);
    }
    return await publish(sb, auth, checked.items, note, rollback?.id);
  } catch (err) {
    if (err instanceof ReleaseRefusal) return answer(err);
    throw err;
  }
}

export const ROLLBACK_COPY = {
  notRestore: 'A rollback publishes the changes restored from one version, and only those.',
  edited:
    'Some of these restored changes were edited after the restore, so they no longer hold that version. Publish them as a release instead.',
  partial:
    'A rollback publishes every change restored from that version together. Select them all, or publish these as a release instead.',
} as const;

/**
 * The version a rollback restores: the one every selected change was restored from, live and
 * published in the caller's tenant, with every open change of that restore selected and none
 * edited since. Read under the person's RLS (CMS staff read every draft of the tenant). Else
 * 422 on `kind`.
 */
async function rollbackOf(
  sb: SupabaseClient,
  auth: AuthContext,
  drafts: readonly StoredDraft[],
): Promise<{ id: string; number: number }> {
  const refuse = (detail: string) =>
    new ReleaseRefusal(422, { ok: false, error: 'validation', field: 'kind', detail });
  const origins = new Set(
    drafts.map((d) => (d.origin_kind === 'restore' ? d.origin_release_id : null)),
  );
  const [origin] = [...origins];
  if (origins.size !== 1 || typeof origin !== 'string') throw refuse(ROLLBACK_COPY.notRestore);
  if (!drafts.every(untouchedRestore)) throw refuse(ROLLBACK_COPY.edited);
  const [set, release] = await Promise.all([
    sb
      .from('content_drafts')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .eq('origin_kind', 'restore')
      .eq('origin_release_id', origin)
      .limit(RELEASE_MAX_ITEMS + 1),
    sb
      .from('content_releases')
      .select('id,number')
      .eq('tenant_id', auth.tenantId)
      .eq('id', origin)
      .eq('status', 'published')
      .maybeSingle(),
  ]);
  if (set.error) throw new Error(`read the restore's changes: ${set.error.message}`);
  if (release.error) throw new Error(`read restored version: ${release.error.message}`);
  const number = (release.data as Record<string, unknown> | null)?.['number'];
  if (typeof number !== 'number') throw refuse(ROLLBACK_COPY.notRestore);
  const selected = new Set(drafts.map((d) => d.id));
  const open = ((set.data ?? []) as Record<string, unknown>[]).map((r) => String(r['id']));
  if (open.some((draftId) => !selected.has(draftId))) throw refuse(ROLLBACK_COPY.partial);
  return { id: origin, number };
}
