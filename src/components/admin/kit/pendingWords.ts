// The pending-change badge's words (Admin v2 R12), out of PendingBadge.tsx so a pure module can
// read them (R14b review): the e2e specs take their copy from here, never a duplicated literal.

export type PendingKind = 'changed' | 'new' | 'removal' | 'scheduled' | 'conflict';

export const PENDING_WORDS: Readonly<Record<PendingKind, string>> = {
  changed: 'Unpublished changes',
  new: 'New · not live yet',
  removal: 'Will be removed',
  scheduled: 'Scheduled',
  conflict: 'Changed on the live site',
};
