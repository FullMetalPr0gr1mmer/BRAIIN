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

export const PENDING_EVENT = 'admin:pending';
export const PUBLISH_EVENT = 'admin:publish';
export const SETTLED_EVENT = 'admin:draft-settled';

/**
 * What a list's or a drawer's DELETE adds when its read came through the release (R12): the
 * server's STAGED_MARKER (src/lib/release/releasesOff.ts). The staged DELETE ignores it; with
 * releases switched off under the screen the live DELETE refuses it (409 `releases-off`) rather
 * than delete for good a row the screen said it would only stage for removal.
 */
export const STAGED_DELETE = '?staged=1';

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
