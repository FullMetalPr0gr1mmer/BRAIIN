// The Admin v2 E10 blocks' layout rules, pure, so a spec can hold them (the components are
// src/components/sections/TextBlock.astro, Gallery.astro and VideoBlock.astro).

import type { ImageRef } from '@/lib/media/resolve';

/**
 * A media section's route data `images`: the page's section media, read once by
 * SectionRenderer and handed over as a promise the section awaits (E10 code review, CR3), so a
 * section without media never waits for it. A promise that never rejects (a failed read is an
 * empty map); a map is taken too.
 */
export type SectionImages = ReadonlyMap<string, ImageRef> | Promise<ReadonlyMap<string, ImageRef>>;

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

/** The widths a Gallery picture asks for in a column (a half or a third of the screen). */
export const GALLERY_WIDTHS = [480, 800, 1200];

/**
 * The widths one picture asks for, at the full width (E10 code review, CR9): up to 1600, as
 * the Video block's still and the media banners. Every width here is one the image guard
 * admits (TRANSFORM_WIDTHS, src/lib/http/imageGuard.ts; tests/lib/imageGuard.spec.ts finds
 * these lists); 2000 is not, and admitting it would be one more transformation per picture.
 */
export const GALLERY_SOLO_WIDTHS = [480, 800, 1200, 1600];

/** The widths a Gallery of `columns` columns asks for. */
export function galleryWidths(columns: 1 | 2 | 3): number[] {
  return columns === 1 ? GALLERY_SOLO_WIDTHS : GALLERY_WIDTHS;
}

type Props = Readonly<Record<string, unknown>>;

const idOf = (value: unknown): string[] => {
  const id = (value as Props | null | undefined)?.['mediaId'];
  return typeof id === 'string' ? [id] : [];
};
const idsOf = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap(idOf) : []);

/**
 * The sections whose content names media library images by `mediaId`, each with how its ids
 * are read: a Gallery's pictures, a Video's still, About's "who" poster, Our Work's two intro
 * frames. Read from the parsed content props by key (never by walking the content), so a
 * crafted body costs nothing here. ONE map (E10 code review, CR5): the types that get the route
 * data (`images`) are its keys, so a type cannot be read without being handed the answer, or
 * the reverse.
 */
export const SECTION_MEDIA_IDS: Readonly<Record<string, (props: Props) => string[]>> = {
  aboutWho: idOf,
  workIntro: (props) => idsOf(props['media']),
  gallery: (props) => idsOf(props['items']),
  video: idOf,
};

/** The sections whose content names media library images by `mediaId` (route data: `images`). */
export const SECTION_MEDIA_TYPES: readonly string[] = Object.keys(SECTION_MEDIA_IDS);

/**
 * Every media library id the given sections' content names, in page order, each once.
 * SectionRenderer reads them in ONE request (getSectionImages) and hands each section the
 * answer as route data.
 */
export function sectionMediaIds(
  sections: readonly { type: string; props?: Record<string, unknown> | undefined }[],
): string[] {
  const ids = sections.flatMap((s) =>
    Object.hasOwn(SECTION_MEDIA_IDS, s.type) ? SECTION_MEDIA_IDS[s.type]!(s.props ?? {}) : [],
  );
  return [...new Set(ids)];
}
