// The case-study gallery's rhythm (UI v2, the mockup's GAL_PATTERN), computed on the
// server so the grid is final HTML rather than classes a script adds after load.
//
// Six columns on desktop; the pattern cycles: one wide still (6 columns), two halves (3),
// three thirds (2), two halves, one wide. On phones the grid is two-up (halves and thirds
// both become half width), and a half-width still left ALONE on its row — before a wide
// one or at the end — stretches to the full width (`mobileFill`) instead of leaving a hole.

export type GallerySpan = 'wide' | 'half' | 'third';

export interface GalleryCell {
  span: GallerySpan;
  /** Phones only: this still would sit alone on its row, so it spans the row. */
  mobileFill: boolean;
}

const PATTERN: readonly GallerySpan[] = [
  'wide',
  'half',
  'half',
  'third',
  'third',
  'third',
  'half',
  'half',
  'wide',
];

export function galleryLayout(count: number): GalleryCell[] {
  const cells: GalleryCell[] = Array.from({ length: Math.max(0, count) }, (_, i) => ({
    span: PATTERN[i % PATTERN.length] as GallerySpan,
    mobileFill: false,
  }));
  // Mobile: a row is two halves; a wide still always starts a fresh row.
  let col = 0;
  cells.forEach((cell, i) => {
    if (cell.span === 'wide') {
      col = 0;
      return;
    }
    col = (col + 3) % 6;
    const next = cells[i + 1];
    if (col === 3 && (!next || next.span === 'wide')) {
      cell.mobileFill = true;
      col = 0;
    }
  });
  return cells;
}
