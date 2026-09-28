import type { Locale } from '@schemas/primitives';
import type { ServiceCaseProject } from '@/lib/data/serviceCases';
import type { ImageRef } from '@/lib/media/resolve';
import { localizedHref, pickLocale } from '@/lib/i18n';

// The case block's image (ServiceCaseBlock, service.html `.case__img`): whose image it is,
// whether it links, and the slot it fills.
//
// It is the project's poster, linking to the project's case study with the project's name
// as its alt (the mockup's), only when the project really HAS a poster. A case whose
// project is unpublished or unset — or published with no poster (an ImageRef is null for
// any provider the page cannot render) — shows the service's own poster instead, UNLINKED
// and with the asset's own alt: the service's still is not the project, and a "See the
// full project" pill on it would say it was (decision S4-7).
//
// The slot follows the layout: beside "Where they were" the image is the grid's wide
// column; with no context it is alone on its row (`.svc-case__top--solo`) and spans the
// band's whole 1280px wrap, so `sizes` says so and a 1600w candidate is offered — a solo
// image described as the 700px column fetched a file upscaled ~1.5x on a 1x laptop.

export type CaseImageLayout = 'split' | 'solo';

/** `sizes` and srcset widths per layout (MediaImage drops widths above the source's). */
export const CASE_IMAGE_SLOT: Record<CaseImageLayout, { sizes: string; widths: number[] }> = {
  // The 1.25fr column from 901px (the grid stacks at ≤900px), the full width below.
  split: { sizes: '(min-width: 56.3125rem) min(52vw, 700px), 100vw', widths: [480, 800, 1200] },
  // The whole wrap: 100vw less the page gutters, never wider than 1280px.
  solo: { sizes: 'min(100vw, 1280px)', widths: [480, 800, 1200, 1600] },
};

export interface CaseFigure {
  image: ImageRef;
  /** The project's case study — set only when `image` IS the project's poster. */
  href: string | null;
  /** The project's name as the alt — only for its own poster; null keeps the asset's alt. */
  alt: string | null;
  layout: CaseImageLayout;
  sizes: string;
  widths: number[];
}

export function caseFigure(opts: {
  project: Pick<ServiceCaseProject, 'slug' | 'title' | 'poster'> | null;
  /** The service's own poster: the image when the project cannot give one. */
  fallback: ImageRef | null;
  /** "Where they were" is shown beside the image. */
  hasContext: boolean;
  locale: Locale;
}): CaseFigure | null {
  const { project, fallback, hasContext, locale } = opts;
  const own = project?.poster ?? null;
  const image = own ?? fallback;
  if (!image) return null;
  const layout: CaseImageLayout = hasContext ? 'split' : 'solo';
  const linked = project !== null && own !== null;
  return {
    image,
    href: linked ? localizedHref(`/portfolio/${project.slug}`, locale) : null,
    alt: linked ? pickLocale(project.title, locale) : null,
    layout,
    ...CASE_IMAGE_SLOT[layout],
  };
}
