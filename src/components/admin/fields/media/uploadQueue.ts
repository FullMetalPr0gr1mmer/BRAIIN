import { MEDIA_META_LIMITS } from '@schemas/media';
import type { FileFacts } from './fileFacts';
import type { MediaRow } from './format';

// The upload dialog's files, as a pure state machine (Admin v2 U4), so every rule is tested
// in node and the dialog only wires the browser to it. Each file moves:
//
//   checking ──facts──▶ ready ──Upload──▶ queued ──▶ sending(progress) ──▶ done
//      │                  ▲                  │             │
//      └──▶ refused-locally│                  │             ├──▶ refused (the server's words)
//                          └──── Cancel ──────┴─────────────┴──▶ failed  (no answer)
//                          ◀──── Try again (refused, failed) ───────────────┘
//
// One file is sent at a time (nextToSend), in the order they were chosen: the Free plan, the
// daily cap and an honest progress bar all prefer it (D9). Cancel aborts the one in flight
// and puts it and every queued file back to ready: nothing stays pending. A file refused
// here (too big, not JPEG/PNG/WebP, unreadable) is never sent.

export type ItemState =
  'checking' | 'ready' | 'refused-locally' | 'queued' | 'sending' | 'done' | 'refused' | 'failed';

export interface UploadItem {
  key: number;
  name: string;
  size: number;
  state: ItemState;
  /** 0 to 1 while sending. */
  progress: number;
  width?: number | undefined;
  height?: number | undefined;
  /** Why it was refused, here or by the server. */
  detail?: string | undefined;
  alt: { en: string; ar: string };
  tags: string[];
  row?: MediaRow | undefined;
}

export type QueueAction =
  | { type: 'add'; files: readonly { key: number; name: string; size: number }[] }
  | { type: 'checked'; key: number; facts: FileFacts }
  | { type: 'edit'; key: number; alt?: Partial<{ en: string; ar: string }>; tags?: string[] }
  | { type: 'submit' }
  | { type: 'sending'; key: number }
  | { type: 'progress'; key: number; fraction: number }
  | { type: 'done'; key: number; row: MediaRow }
  | { type: 'refused'; key: number; detail: string }
  | { type: 'failed'; key: number; detail: string }
  | { type: 'retry'; key: number }
  | { type: 'cancel' }
  | { type: 'remove'; key: number }
  | { type: 'clear' };

/** Text an alt field may hold: what MediaAltSchema admits (no control character). */
const CONTROL = /[\p{Cc}\p{Cs}\u2028\u2029]/u;

/** What is wrong with one language's alt text, or null. */
export function altProblem(text: string): string | null {
  const value = text.trim();
  if (value === '') return 'is required';
  if (value.length > MEDIA_META_LIMITS.alt) return `is at most ${MEDIA_META_LIMITS.alt} characters`;
  if (CONTROL.test(value)) return 'cannot hold line breaks or control characters';
  return null;
}

/** Ready to send: checked, and described in both languages. */
export function describedEnough(item: UploadItem): boolean {
  return altProblem(item.alt.en) === null && altProblem(item.alt.ar) === null;
}

const patch = (items: readonly UploadItem[], key: number, change: Partial<UploadItem>) =>
  items.map((item) => (item.key === key ? { ...item, ...change } : item));

export function queueReducer(items: readonly UploadItem[], action: QueueAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [
        ...items,
        ...action.files.map((f): UploadItem => ({
          ...f,
          state: 'checking',
          progress: 0,
          alt: { en: '', ar: '' },
          tags: [],
        })),
      ];
    case 'checked': {
      const item = items.find((i) => i.key === action.key);
      if (!item || item.state !== 'checking') return [...items];
      return action.facts.ok
        ? patch(items, action.key, {
            state: 'ready',
            width: action.facts.width,
            height: action.facts.height,
          })
        : patch(items, action.key, { state: 'refused-locally', detail: action.facts.detail });
    }
    case 'edit': {
      const item = items.find((i) => i.key === action.key);
      if (!item || item.state === 'sending' || item.state === 'done') return [...items];
      return patch(items, action.key, {
        ...(action.alt ? { alt: { ...item.alt, ...action.alt } } : {}),
        ...(action.tags ? { tags: action.tags } : {}),
      });
    }
    case 'submit':
      // Every checked, described file is queued; the rest wait (the dialog names what is
      // missing). A file refused by the server is queued again only through Try again.
      return items.map((item) =>
        item.state === 'ready' && describedEnough(item) ? { ...item, state: 'queued' } : item,
      );
    case 'sending':
      return patch(items, action.key, { state: 'sending', progress: 0, detail: undefined });
    case 'progress': {
      const item = items.find((i) => i.key === action.key);
      if (!item || item.state !== 'sending') return [...items];
      return patch(items, action.key, {
        progress: Math.max(item.progress, Math.min(1, Math.max(0, action.fraction))),
      });
    }
    case 'done':
      return patch(items, action.key, { state: 'done', progress: 1, row: action.row });
    case 'refused':
      return patch(items, action.key, { state: 'refused', detail: action.detail, progress: 0 });
    case 'failed':
      return patch(items, action.key, { state: 'failed', detail: action.detail, progress: 0 });
    case 'retry': {
      const item = items.find((i) => i.key === action.key);
      if (!item || (item.state !== 'refused' && item.state !== 'failed')) return [...items];
      return patch(items, action.key, {
        state: describedEnough(item) ? 'queued' : 'ready',
        detail: undefined,
      });
    }
    case 'cancel':
      return items.map((item) =>
        item.state === 'sending' || item.state === 'queued'
          ? { ...item, state: 'ready', progress: 0 }
          : item,
      );
    case 'remove':
      return items.filter((item) => item.key !== action.key || item.state === 'sending');
    case 'clear':
      return [];
  }
}

/** The next file to send, if none is in flight: the first queued, in the order chosen. */
export function nextToSend(items: readonly UploadItem[]): UploadItem | null {
  if (items.some((item) => item.state === 'sending')) return null;
  return items.find((item) => item.state === 'queued') ?? null;
}

/** How the batch stands, for the footer and the toast. */
export function queueSummary(items: readonly UploadItem[]) {
  const count = (state: ItemState) => items.filter((i) => i.state === state).length;
  const sendable = items.filter((i) => i.state === 'ready').length;
  return {
    sendable,
    done: count('done'),
    busy: count('sending') + count('queued') > 0,
    checking: count('checking') > 0,
    problems: count('refused') + count('failed'),
  };
}
