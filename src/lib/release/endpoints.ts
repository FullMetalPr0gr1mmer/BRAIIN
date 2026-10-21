import type { PublishRequest } from '@schemas/release';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { checkOf, dryRun, publish } from './apply';
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
    if (input.kind === 'rollback') {
      // Restoring a version stages its state as changes first (R10), which then publish as a
      // rollback naming the version: nothing can name one yet.
      return json(
        {
          ok: false,
          error: 'validation',
          field: 'kind',
          detail: 'Restoring a version is not available yet.',
        },
        422,
      );
    }
    if (!(await ctx.releasesEnabled())) {
      return json({ ok: false, error: 'releases-off', detail: RELEASES_OFF_DETAIL }, 409);
    }
    const drafts = await loadSelection(sb, auth, input.items);
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
    if (mode === 'validate') return await dryRun(auth, checked.items, input.note);
    return await publish(sb, auth, checked.items, input.note);
  } catch (err) {
    if (err instanceof ReleaseRefusal) return answer(err);
    throw err;
  }
}
