import { useRef } from 'react';
import { rowStamp, savedSince } from './model';

// What a template editor's form tells the screen (Admin v2 E3): every row it read or saved says
// whether the record is in release mode (a release-managed route answers with a `draft` key
// while releases are on, R12), and a row whose version or pending change moved since the last
// one is a save, which reloads the preview (the form's first read, or a reread of the same
// version, is not). One per form: a new form starts with no row seen.

export function useSaveSignal(
  onSaved: () => void,
  onMode: (release: boolean) => void,
): (row: Record<string, unknown>) => void {
  const stamp = useRef<string | null>(null);
  return (row) => {
    onMode('draft' in row);
    if (savedSince(stamp.current, row)) onSaved();
    stamp.current = rowStamp(row);
  };
}
