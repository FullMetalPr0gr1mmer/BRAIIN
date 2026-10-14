import Icon from './Icon';
import { formatTime, type Instant } from '@/lib/admin/relTime';

// Where a save stands (Admin v2 F4b): "Unsaved changes", "Saving…", "Saved at 14:05",
// "Not saved". Always words (the colour and the icon repeat them), in a status region that
// exists from the first render so each change is announced politely. While saving, the
// loader spins; reduced motion stops it and the words stay (ui.md §1.4). The editor's
// save hook (F5's useEntitySave) drives it.

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const WORDS: Record<SaveState, string> = {
  idle: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
};

export interface SaveStatusProps {
  state: SaveState;
  /** When the last save landed: "Saved at 14:05" (Riyadh time). */
  savedAt?: Instant | null | undefined;
  /** Replaces "Not saved" with the reason ("Not saved: someone else changed this"). */
  error?: string | undefined;
}

/** The words for a state. */
export function saveStatusText(state: SaveState, savedAt?: Instant | null, error?: string) {
  if (state === 'saved' && savedAt) {
    const time = formatTime(savedAt);
    if (time) return `Saved at ${time}`;
  }
  if (state === 'error' && error) return error;
  return WORDS[state];
}

export default function SaveStatus({ state, savedAt, error }: SaveStatusProps) {
  return (
    <p className="save-status" data-state={state} role="status">
      {state === 'saving' && <Icon name="loader" size={14} className="spin" />}
      {state === 'saved' && <Icon name="check" size={14} />}
      {saveStatusText(state, savedAt, error)}
    </p>
  );
}
