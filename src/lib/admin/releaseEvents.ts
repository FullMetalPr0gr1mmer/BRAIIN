// The two events the release UI listens to (Admin v2 R12; ui.md §2.6 "dispatches an
// `admin:pending` CustomEvent for the savebar"). Browser only; a few bytes, so the editors (the
// field kit's chunk), the lists (admin-ui) and the savebar (admin-release) share them without
// any of them importing another's code.
//
//   - `admin:pending`: a pending change was saved, thrown away or settled. The savebar reads
//     the pending summary again (it also does on focus and when the tab is shown again).
//     Dispatched only after an answer that came from the release path (a row with `draft`, a
//     staged list action): with releases off nothing dispatches it, and no savebar listens.
//   - `admin:publish`: open the publish dialog (E1's page editor and R13's dashboard card;
//     `detail.entityId` scrolls to and highlights that item's changes).
//   - `admin:draft-settled`: a pending change was settled (Keep my version / Use the live
//     version) in the publish dialog, so its version moved. An editor open on it reads it again,
//     keeping what was typed since its last save, instead of meeting a "Someone else saved"
//     conflict on its next save (R12 pre-merge review).
//   - `admin:drafts-discarded`: pending changes were thrown away in the publish dialog or the
//     savebar (Admin v2 E2 review). The page editor reads its sections again and reloads its
//     live preview, which laid them over the page. An open editor's form is not told: its next
//     save meets R12's `draft-discarded` and says so, as before.

export const PENDING_EVENT = 'admin:pending';
export const PUBLISH_EVENT = 'admin:publish';
export const SETTLED_EVENT = 'admin:draft-settled';
export const DISCARDED_EVENT = 'admin:drafts-discarded';

/**
 * What a write made in release mode adds to its address (R12, R12b): the server's
 * STAGED_MARKER (src/lib/release/releasesOff.ts). The staged paths ignore it; with releases
 * switched off under the screen, the live DELETE, create (POST) and reorder (POST) of a
 * release-managed resource refuse it (409 `releases-off`) before they read or write anything,
 * rather than write live what the screen would only have staged. A PATCH or PUT says the same
 * in its body (`staged: true`, entitySave.ts STAGED_KEY).
 */
export const STAGED_QUERY = '?staged=1';

/** R12's name for STAGED_QUERY on a list's or a drawer's DELETE. */
export const STAGED_DELETE = STAGED_QUERY;

/**
 * A write's address as a screen sends it (R12b): with STAGED_QUERY when the screen is in
 * release mode, else exactly as it was (releases off: the request main sends).
 */
export function stagedUrl(url: string, staged: boolean): string {
  if (!staged) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${STAGED_QUERY.slice(1)}`;
}

/**
 * A PATCH body as a screen sends it (R12b, a list's eye): with `staged: true` (the editors'
 * STAGED_KEY, entitySave.ts) when the screen is in release mode, else the body unchanged.
 */
export function stagedBody<T extends Record<string, unknown>>(
  body: T,
  staged: boolean,
): T | (T & { staged: true }) {
  return staged ? { ...body, staged: true } : body;
}

/**
 * Whether a list answer came through the release (R3a: `stagedList` always answers
 * `draftsInvalid`, and only with releases on). This is the SCREEN's mode, and it decides every
 * write the screen sends (R12b): a row is no guide, since a row with nothing pending carries
 * no `draft` key at all, exactly like a row read live.
 */
export function readsThroughRelease(answer: unknown): boolean {
  return (
    typeof answer === 'object' &&
    answer !== null &&
    Array.isArray((answer as Record<string, unknown>)['draftsInvalid'])
  );
}

export interface PublishEventDetail {
  entityId?: string | undefined;
}

export interface SettledEventDetail {
  draftId: string;
}

/** Tell the savebar the pending changes moved. */
export function announcePending(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PENDING_EVENT));
}

/** Open the publish dialog, optionally on one item's changes. */
export function openPublishDialog(detail: PublishEventDetail = {}): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PublishEventDetail>(PUBLISH_EVENT, { detail }));
}

/** Tell an editor open on this pending change that it was settled elsewhere. */
export function announceSettled(draftId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<SettledEventDetail>(SETTLED_EVENT, { detail: { draftId } }));
}

/** Listen for a settled pending change (its id); returns the unsubscribe. */
export function onSettled(handler: (draftId: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => {
    const draftId = (event as CustomEvent<Partial<SettledEventDetail> | null>).detail?.draftId;
    if (typeof draftId === 'string') handler(draftId);
  };
  window.addEventListener(SETTLED_EVENT, listener);
  return () => window.removeEventListener(SETTLED_EVENT, listener);
}

/** Tell the page editor that pending changes were thrown away (after the server did it). */
export function announceDiscarded(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DISCARDED_EVENT));
}

/**
 * Listen for any pending change settled or thrown away elsewhere (the publish dialog, the
 * savebar); returns the unsubscribe. The page editor's live preview follows both (E2).
 */
export function onDraftsMoved(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const offSettled = onSettled(() => handler());
  const listener = () => handler();
  window.addEventListener(DISCARDED_EVENT, listener);
  return () => {
    offSettled();
    window.removeEventListener(DISCARDED_EVENT, listener);
  };
}
