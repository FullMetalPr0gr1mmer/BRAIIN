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

export const PENDING_EVENT = 'admin:pending';
export const PUBLISH_EVENT = 'admin:publish';

export interface PublishEventDetail {
  entityId?: string | undefined;
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
