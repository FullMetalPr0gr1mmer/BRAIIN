import { Badge } from './StatusBadge';
import type { BadgeTone } from '@/lib/admin/tones';

// The pending-change badge (Admin v2 R12; releases.md §7 "Per-item badges"): beside a row's
// live status in the lists, and at the head of an editor, so a change waiting for a release is
// visible where the item is. Words, never only a colour. Drawn only for a row that carries a
// pending change, which only happens with releases on (the list and item reads add `draft`,
// R3a), so with releases off no list or editor draws one.

export type PendingKind = 'changed' | 'new' | 'removal' | 'scheduled' | 'conflict';

export const PENDING_WORDS: Readonly<Record<PendingKind, string>> = {
  changed: 'Unpublished changes',
  new: 'New · not live yet',
  removal: 'Will be removed',
  scheduled: 'Scheduled',
  conflict: 'Changed on the live site',
};

const TONES: Readonly<Record<PendingKind, BadgeTone>> = {
  changed: 'klein',
  new: 'sky',
  removal: 'err',
  scheduled: 'sky',
  conflict: 'warn',
};

/** What a row's (or an item read's) pending change is, or null when it carries none. */
export function pendingKindOf(row: Readonly<Record<string, unknown>>): PendingKind | null {
  const draft = row['draft'];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    return row['pendingRemoval'] === true ? 'removal' : null;
  }
  const meta = draft as Record<string, unknown>;
  if (typeof meta['releaseId'] === 'string') return 'scheduled';
  if (meta['op'] === 'delete' || row['pendingRemoval'] === true) return 'removal';
  if (meta['op'] === 'create') return 'new';
  if (meta['liveMissing'] === true) return 'conflict';
  if (Array.isArray(meta['conflict']) && meta['conflict'].length > 0) return 'conflict';
  return 'changed';
}

export default function PendingBadge({ kind }: { kind: PendingKind }) {
  return (
    <Badge tone={TONES[kind]} className="badge--pending">
      {PENDING_WORDS[kind]}
    </Badge>
  );
}
