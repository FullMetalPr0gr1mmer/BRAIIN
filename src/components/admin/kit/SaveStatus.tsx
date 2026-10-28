import Icon from './Icon';
import { clockFor, type Clock, type Instant } from '@/lib/admin/relTime';
import { pageTimeZone, useClock } from './clock';

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
  /** When the last save landed: "Saved at 14:05" (the studio's time, Admin v2 U9). */
  savedAt?: Instant | null | undefined;
  /** Replaces "Not saved" with the reason ("Not saved: someone else changed this"). */
  error?: string | undefined;
  /**
   * Admin v2 R12: the save made a pending change (release mode): "Saved as an unpublished
   * change at 14:05". Absent, the words are what they were.
   */
  staged?: boolean | undefined;
}

/** The words for a state. */
export function saveStatusText(
  state: SaveState,
  savedAt?: Instant | null,
  error?: string,
  clock: Clock = clockFor(pageTimeZone()),
  staged = false,
) {
  if (state === 'saved' && savedAt) {
    const time = clock.formatTime(savedAt);
    if (time) return staged ? `Saved as an unpublished change at ${time}` : `Saved at ${time}`;
  }
  if (state === 'saved' && staged) return 'Saved as an unpublished change';
  if (state === 'error' && error) return error;
  return WORDS[state];
}

export default function SaveStatus({ state, savedAt, error, staged }: SaveStatusProps) {
  const clock = useClock();
  return (
    <p className="save-status" data-state={state} role="status">
      {state === 'saving' && <Icon name="loader" size={14} className="spin" />}
      {state === 'saved' && <Icon name="check" size={14} />}
      {saveStatusText(state, savedAt, error, clock, staged === true)}
    </p>
  );
}
