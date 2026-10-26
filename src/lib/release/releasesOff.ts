import { DraftConflictError } from '@/lib/admin/errors';

// A write made in release mode, arriving after releases were switched off (Admin v2 R12,
// pre-merge review). An editor or a list keeps the mode its last answer gave it until it reloads,
// so one left open across `app.disable_releases` (which may throw every pending change away)
// would send its next save or delete to the live path: the editor's next autosave would write
// the whole form, the thrown-away change in it, to the live row, and a list's "Remove" (which
// promised nothing leaves the site until it is published) would delete the row for good.
//
// So a write made in release mode says so: an editor's save names its pending change
// (`draftId` + `draftVersion`) or, with nothing pending yet, carries `staged: true`; a list's or
// a drawer's DELETE carries `?staged=1`. With releases on the staged path reads the change it
// names and ignores the marker. With releases off the live path of every release-managed route
// refuses such a request, 409 `releases-off`, before it reads or writes anything. No client
// sends these with releases off, so the live path is otherwise what it always was.

/** The body key (a save) and the query parameter (a DELETE) that say "made in release mode". */
export const STAGED_MARKER = 'staged';

/** What the refusal says (the editor shows its own words, with a Reload button). */
export const STALE_MODE_DETAIL = 'Publishing was switched off. Reload to edit the live site.';

/** Every name that says a request was made in release mode. */
const RELEASE_NAMES = ['draftId', 'draftVersion', STAGED_MARKER] as const;

const releasesOff = (entity: string) =>
  new DraftConflictError('releases-off', entity, null, STALE_MODE_DETAIL);

/** Releases off: refuse a save whose body names a pending change or says it was staged. */
export function refuseStagedBody(raw: unknown, entity: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  if (RELEASE_NAMES.some((name) => name in raw)) throw releasesOff(entity);
}

/** Releases off: refuse a DELETE whose address says it was made in release mode. */
export function refuseStagedQuery(url: URL, entity: string): void {
  if (RELEASE_NAMES.some((name) => url.searchParams.has(name))) throw releasesOff(entity);
}
