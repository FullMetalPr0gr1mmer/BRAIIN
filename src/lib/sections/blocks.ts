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

/** The sections whose content names media library images by `mediaId` (route data: `images`). */
export const SECTION_MEDIA_TYPES: readonly string[] = ['aboutWho', 'workIntro', 'gallery', 'video'];

type Props = Readonly<Record<string, unknown>>;

const idOf = (value: unknown): string[] => {
  const id = (value as Props | null | undefined)?.['mediaId'];
  return typeof id === 'string' ? [id] : [];
};
const idsOf = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap(idOf) : []);

/**
 * Every media library id the given sections' content names, in page order, each once: a
 * Gallery's pictures, a Video's still, About's "who" poster, Our Work's two intro frames. Read
 * from the parsed content props by key (never by walking the content), so a crafted body costs
 * nothing here. SectionRenderer reads them in ONE request (getSectionImages) and hands each
 * section the answer as route data.
 */
export function sectionMediaIds(
  sections: readonly { type: string; props?: Record<string, unknown> | undefined }[],
): string[] {
  const ids = sections.flatMap((s) => {
    const props: Props = s.props ?? {};
    switch (s.type) {
      case 'gallery':
        return idsOf(props['items']);
      case 'workIntro':
        return idsOf(props['media']);
      case 'aboutWho':
      case 'video':
        return idOf(props);
      default:
        return [];
    }
  });
  return [...new Set(ids)];
}
