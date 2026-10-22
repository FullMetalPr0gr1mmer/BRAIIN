import type { SupabaseClient } from '@supabase/supabase-js';
import type { PublishRequest } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { checkOf, dryRun, publish } from './apply';
import type { StoredDraft } from './drafts';
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
// A rollback (R10, `kind: 'rollback'`) publishes the changes a restore staged: every selected
// change must carry the restore's mark for one version (`origin_kind`, `origin_release_id`, which
// only the restore path writes), and the release then names that version
// (`restores_release_id`) with the default note "Restored vN". Anything else is 422 on `kind`.

type Ctx = AdminRouteContext<PublishRequest>;

export const RELEASES_OFF_DETAIL = 'Publishing is switched off: every save goes live at once.';

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
    return await publish(sb, auth, checked.items, note, rollback?.id);
  } catch (err) {
    if (err instanceof ReleaseRefusal) return answer(err);
    throw err;
  }
}

export const ROLLBACK_DETAIL =
  'A rollback publishes the changes restored from one version, and only those.';

/**
 * The version a rollback restores: the one every selected change was restored from, live and
 * published in the caller's tenant. Read under the person's RLS. Else 422 on `kind`.
 */
async function rollbackOf(
  sb: SupabaseClient,
  auth: AuthContext,
  drafts: readonly StoredDraft[],
): Promise<{ id: string; number: number }> {
  const refuse = () =>
    new ReleaseRefusal(422, {
      ok: false,
      error: 'validation',
      field: 'kind',
      detail: ROLLBACK_DETAIL,
    });
  const { data, error } = await sb
    .from('content_drafts')
    .select('id,origin_kind,origin_release_id')
    .eq('tenant_id', auth.tenantId)
    .in(
      'id',
      drafts.map((d) => d.id),
    );
  if (error) throw new Error(`read restore marks: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  const origins = new Set(
    rows.map((r) => (r['origin_kind'] === 'restore' ? r['origin_release_id'] : null)),
  );
  const [origin] = [...origins];
  if (rows.length !== drafts.length || origins.size !== 1 || typeof origin !== 'string') {
    throw refuse();
  }
  const release = await sb
    .from('content_releases')
    .select('id,number')
    .eq('tenant_id', auth.tenantId)
    .eq('id', origin)
    .eq('status', 'published')
    .maybeSingle();
  if (release.error) throw new Error(`read restored version: ${release.error.message}`);
  const number = (release.data as Record<string, unknown> | null)?.['number'];
  if (typeof number !== 'number') throw refuse();
  return { id: origin, number };
}
