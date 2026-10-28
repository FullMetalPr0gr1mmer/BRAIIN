// The history drawer's words and the answer it reads (Admin v2 R13; releases.md §7 "History
// drawer"; GET /api/admin/history, R10). Pure, so tests/lib/versionsPage.spec.ts holds its
// lines (P-12: plain, warm, no dashes) and tests/admin/backups.e2e.ts opens the drawer.

interface Named {
  id: string;
  name: string | null;
}

/** One version of the record, as R10's history lists it. */
export interface HistoryVersion {
  seq: number;
  version: number;
  at: string;
  by: Named | null;
  release: { id: string; number: number | null } | null;
  live: boolean;
}

/** `GET /api/admin/history` for one record (scope `item`). */
export interface HistoryAnswer {
  enabled: boolean;
  live: boolean;
  restorable: boolean;
  pending: {
    draftId: string;
    draftVersion: number;
    op: string;
    by: Named | null;
    at: string;
    scheduled: boolean;
    restore: boolean;
  } | null;
  versions: HistoryVersion[];
  more: boolean;
}

/** "Version 4 · live now", "Version 3 · in release v12", or "Version 2". */
export function historyRowTitle(v: Pick<HistoryVersion, 'seq' | 'live' | 'release'>): string {
  const number = v.release?.number ?? null;
  if (number !== null) return `Version ${v.seq} · in release v${number}`;
  return `Version ${v.seq}`;
}

export const HISTORY_COPY = {
  sub: 'Every version of this that went live, newest first.',
  off: 'Publishing in releases isn’t switched on yet, so these are the saves that went live. Restoring an earlier version arrives when it is switched on.',
  teamNoHistory: 'History isn’t kept for team members yet.',
  empty: 'No history yet.',
  unreadable: 'The history couldn’t be read. Close this and try again.',
  forbidden: 'Your role can’t open this history.',
  pendingTitle: 'Unpublished changes',
  pendingLine: 'Saved, not live yet: it goes live when it is published.',
  pendingScheduled:
    'Scheduled to go live with a release. Unschedule it on Backups & versions to change it.',
  restoreConfirm: (seq: number) =>
    `Restore version ${seq}? It comes back as an unpublished change for you to review. Nothing goes live until you publish.`,
  restored: (seq: number) => `Version ${seq} restored. Publish to make it live.`,
  restoreFailed: 'That version couldn’t be restored. Try again in a moment.',
  discardConfirm: (label: string) =>
    `Discard this change? Your unpublished changes to ${label} will be thrown away. The live site doesn’t change.`,
  discarded: 'Change thrown away.',
  discardFailed: 'The change couldn’t be thrown away. Try again in a moment.',
} as const;
