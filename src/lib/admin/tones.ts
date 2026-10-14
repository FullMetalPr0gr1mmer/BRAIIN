import type { IconName } from './icons';

// The tones and states the kit's badges and notes take (Admin v2 F4b, docs/admin-v2/ui.md
// §1.2, §2.4), in one place for the server primitives and the React kit alike. Each is a
// data attribute admin.css styles (`data-tone`, `data-status`), never a colour in markup.

/** A badge's tone: `.badge[data-tone]` in admin.css. */
export const BADGE_TONES = ['klein', 'sky', 'ok', 'warn', 'err', 'gray', 'dark'] as const;
export type BadgeTone = (typeof BADGE_TONES)[number];

/**
 * The content lifecycle (CLAUDE.md §8: one `content_status` enum) plus `pending`, a change
 * waiting in a release (REL). `.badge[data-status]` maps each to a tone: published ok,
 * draft warn, scheduled sky, archived gray, pending klein.
 */
export const CONTENT_STATUSES = ['draft', 'scheduled', 'published', 'archived', 'pending'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

const STATUS_LABEL: Record<ContentStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  archived: 'Archived',
  pending: 'Pending',
};

export function isContentStatus(value: unknown): value is ContentStatus {
  return typeof value === 'string' && (CONTENT_STATUSES as readonly string[]).includes(value);
}

/** The word a status badge shows: the state is always text, never only a colour. */
export function statusLabel(status: string): string {
  return isContentStatus(status) ? STATUS_LABEL[status] : status;
}

/** A note's tone: `.note[data-tone]`, with the icon that says it without the colour. */
export const NOTE_TONES = ['info', 'warn', 'ok', 'err'] as const;
export type NoteTone = (typeof NOTE_TONES)[number];

export const NOTE_ICON: Record<NoteTone, IconName> = {
  info: 'info',
  warn: 'warn',
  ok: 'check',
  err: 'warn',
};
