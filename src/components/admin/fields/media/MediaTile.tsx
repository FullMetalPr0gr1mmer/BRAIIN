import type { KeyboardEvent, MouseEvent, Ref } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { altGap, caption, factsLine, sizeText, type MediaRow } from './format';

// One picture of the grid (Admin v2 U4, the prototype's .mi): a 4:3 thumbnail, its size in
// the inline-end corner, a "No alt text" / "No Arabic alt" badge, and its name on a solid
// band (D15: the prototype's gradient over the photo cannot be proven AA, a token band can).
// A <button>, named by its caption first (WCAG 2.5.3) and then what the corner and the badge
// show, so a screen reader hears what is seen. The thumbnail is decorative (alt=""): the
// name already says what the picture is.
//
// `open` (the library): a press opens the picture. `pick` (the picker): a press or Space
// selects it (aria-pressed), Enter or a double click chooses it.

export interface MediaTileProps {
  row: MediaRow;
  mode: 'open' | 'pick';
  selected: boolean;
  /** Roving focus: the one tile of the grid in the Tab order. */
  tabbable: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onPress: (row: MediaRow) => void;
  onChoose: (row: MediaRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus: () => void;
}

/** The tile's accessible name: "Desert dunes.jpg, 2,560 by 1,707, 412 KB, No Arabic alt". */
export function tileName(row: MediaRow): string {
  return [caption(row), factsLine(row), altGap(row)].filter(Boolean).join(', ');
}

export default function MediaTile({
  row,
  mode,
  selected,
  tabbable,
  buttonRef,
  onPress,
  onChoose,
  onKeyDown,
  onFocus,
}: MediaTileProps) {
  const thumb = typeof row['thumb_url'] === 'string' ? row['thumb_url'] : null;
  const size = sizeText(row['size_bytes']);
  const gap = row['kind'] === 'image' ? altGap(row) : null;
  const width = Number(row['width']) > 0 ? Number(row['width']) : 320;
  const height = Number(row['height']) > 0 ? Number(row['height']) : 240;
  return (
    <button
      ref={buttonRef}
      type="button"
      className="mi"
      tabIndex={tabbable ? 0 : -1}
      aria-label={tileName(row)}
      aria-pressed={mode === 'pick' ? selected : undefined}
      aria-current={mode === 'open' && selected ? 'true' : undefined}
      aria-haspopup={mode === 'open' ? 'dialog' : undefined}
      data-id={String(row['id'] ?? '')}
      onClick={() => onPress(row)}
      onDoubleClick={(event: MouseEvent) => {
        if (mode !== 'pick') return;
        event.preventDefault();
        onChoose(row);
      }}
      onKeyDown={(event) => {
        if (mode === 'pick' && event.key === 'Enter') {
          event.preventDefault();
          onChoose(row);
          return;
        }
        onKeyDown(event);
      }}
      onFocus={onFocus}
    >
      {thumb ? (
        <img src={thumb} alt="" width={width} height={height} loading="lazy" decoding="async" />
      ) : (
        <span className="mi__ph" aria-hidden="true">
          <Icon name="image" size={24} />
        </span>
      )}
      {size && (
        <span className="mi__size" aria-hidden="true">
          {size}
        </span>
      )}
      {gap && (
        <span className="mi__alt" aria-hidden="true">
          {gap}
        </span>
      )}
      <span className="mi__cap" aria-hidden="true">
        {caption(row)}
      </span>
    </button>
  );
}
