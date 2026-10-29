// The Admin v2 E10 blocks' layout rules, pure, so a spec can hold them (the components are
// src/components/sections/TextBlock.astro, Gallery.astro and VideoBlock.astro).

/**
 * How many columns a Gallery of `count` pictures takes on a wide screen: one picture is the
 * full width, two or four are halves (a square of four, not three and one), three and from five
 * up are thirds. A phone shows two a row from two pictures up (global.css `.blk-gal__grid`).
 */
export function galleryColumns(count: number): 1 | 2 | 3 {
  if (count <= 1) return 1;
  if (count === 2 || count === 4) return 2;
  return 3;
}
