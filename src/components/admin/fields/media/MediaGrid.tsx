import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { arrowStep } from '@/lib/admin/roving';
import type { MediaRow } from './format';
import MediaTile from './MediaTile';

// The tile grid the library and every picker share (Admin v2 U4, the prototype's .media):
// a list of picture buttons, the grid one Tab stop (roving tabindex), arrows moving between
// tiles as the eye reads them: left and right along a row (mirrored in right-to-left text),
// up and down a column, Home and End to the ends. It scrolls with the page or the dialog,
// never in a box of its own (no unnamed scrolling region for axe to find).

export interface MediaGridProps {
  rows: readonly MediaRow[];
  mode: 'open' | 'pick';
  /** The list's name ("Pictures"). */
  label: string;
  /** pick: the chosen tile (aria-pressed); open: the tile whose drawer is open. */
  selectedId?: string | null | undefined;
  /** open: a press opens the picture; pick: a press selects it. */
  onPress: (row: MediaRow) => void;
  /** pick: Enter or a double click chooses it. */
  onChoose?: (row: MediaRow) => void;
  /** A tile to move focus to once it is rendered (a closed drawer's tile). */
  focusId?: string | null | undefined;
}

/**
 * Where a key moves focus from `index` in a grid of `count` tiles, `columns` to a row, or
 * null when the key is not the grid's (the browser keeps it). Never wraps: an arrow past an
 * edge stays put, as a grid of pictures reads.
 */
export function gridMove(
  key: string,
  index: number,
  count: number,
  columns: number,
  rtl = false,
): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const cols = Math.max(1, Math.floor(columns));
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const next = index + (key === 'ArrowDown' ? cols : -cols);
    return next >= 0 && next < count ? next : index;
  }
  const step = arrowStep(key, { orientation: 'horizontal', rtl });
  if (step === 0) return null;
  return Math.min(count - 1, Math.max(0, index + step));
}

/** How many tiles sit on the first row, read from the layout. */
function columnsOf(list: HTMLElement | null): number {
  const items = list ? [...list.children] : [];
  const first = items[0] as HTMLElement | undefined;
  if (!first) return 1;
  const top = first.offsetTop;
  const perRow = items.filter((el) => (el as HTMLElement).offsetTop === top).length;
  return Math.max(1, perRow);
}

export default function MediaGrid({
  rows,
  mode,
  label,
  selectedId,
  onPress,
  onChoose,
  focusId,
}: MediaGridProps) {
  const list = useRef<HTMLUListElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const ids = rows.map((row) => String(row['id'] ?? ''));
  const selectedIndex = selectedId ? ids.indexOf(selectedId) : -1;
  const [active, setActive] = useState(Math.max(0, selectedIndex));
  const current = Math.min(active, Math.max(0, rows.length - 1));

  // A new page starts at its first tile (or the chosen one): only a new list resets the
  // roving position, so the effects key on the ids, not on the rows' identity.
  const signature = ids.join(',');
  const latest = useRef({ ids, selectedId });
  latest.current = { ids, selectedId };
  useEffect(() => {
    const { ids: now, selectedId: chosen } = latest.current;
    setActive(Math.max(0, chosen ? now.indexOf(chosen) : 0));
  }, [signature]);

  // Only a new focusId moves focus: a later reload of the list (an upload, a save) must never
  // pull focus out of the search box to the tile a drawer once closed on.
  useEffect(() => {
    if (!focusId) return;
    const index = latest.current.ids.indexOf(focusId);
    if (index < 0) return;
    setActive(index);
    buttons.current[index]?.focus();
  }, [focusId]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const rtl = (event.currentTarget.closest('[dir]')?.getAttribute('dir') ?? 'ltr') === 'rtl';
    const next = gridMove(event.key, index, rows.length, columnsOf(list.current), rtl);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    buttons.current[next]?.focus();
  }

  return (
    <ul ref={list} className="media" aria-label={label} data-mode={mode}>
      {rows.map((row, index) => {
        const id = ids[index] ?? String(index);
        return (
          <li key={id}>
            <MediaTile
              row={row}
              mode={mode}
              selected={selectedId === id}
              tabbable={index === current}
              buttonRef={(el) => {
                buttons.current[index] = el;
              }}
              onPress={onPress}
              onChoose={(r) => onChoose?.(r)}
              onKeyDown={(event) => onKeyDown(event, index)}
              onFocus={() => setActive(index)}
            />
          </li>
        );
      })}
    </ul>
  );
}
