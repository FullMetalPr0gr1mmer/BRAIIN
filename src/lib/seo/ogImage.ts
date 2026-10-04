import type { Locale } from '@schemas/primitives';
import type { ResolvedSeo } from '@/lib/data/seo';

// A page's share image — og:image and twitter:image (CLAUDE.md Pillar 3). Every public page
// names one: a link pasted into a chat, a post or a search result unfurls with a picture.
//
// Precedence, the first USABLE candidate wins:
//   1. the page's SEO override — `entity_seo.og_image`, the SEO role's choice for that page;
//   2. the page's own image — a service's poster, a case study's banner frame, a post's cover;
//   3. the tenant default — `seo_defaults.default_og_image`, for a page with nothing of its own;
//   4. the code default — the logo card, public/og/default.jpg (scripts/gen-og-image.mjs).
// (3) used to rank ABOVE (2): authoring a site default in Admin would have replaced every
// service poster and case-study banner in link previews with one picture.
//
// og:image must be an absolute URL, so a candidate is resolved against the site origin, and
// only http(s) without credentials passes. A blank, `javascript:`, `data:` or malformed value
// is not "usable": it falls through to the next candidate instead of reaching a crawler.

export const DEFAULT_OG_IMAGE = Object.freeze({
  path: '/og/default.jpg',
  width: 1200,
  height: 630,
  type: 'image/jpeg',
});

/** In precedence order; `null`/`undefined`/blank entries are skipped. */
export type OgImageCandidates = readonly (string | null | undefined)[];

export interface ResolvedOgImage {
  url: string;
  /** Known for the code default only — the card's size, type and description. */
  width?: number;
  height?: number;
  type?: string;
  alt?: string;
}

/** `value` as an absolute http(s) URL against `base` (an origin), or undefined if unusable. */
export function absoluteHttpUrl(
  value: string | null | undefined,
  base: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, `${base.replace(/\/+$/, '')}/`);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  return url.href;
}

/** The candidates in precedence order: the override, the page's own image, the default. */
export function ogImageCandidates(
  seo: Pick<ResolvedSeo, 'entityOgImage' | 'defaultOgImage'>,
  own?: string | null,
): OgImageCandidates {
  return [seo.entityOgImage, own, seo.defaultOgImage];
}

/** The first usable candidate, else the logo card with its size, type and alt text. */
export function resolveOgImage(
  candidates: OgImageCandidates,
  context: { base: string; locale: Locale; brand: string },
): ResolvedOgImage {
  for (const candidate of candidates) {
    const url = absoluteHttpUrl(candidate, context.base);
    if (url) return { url };
  }
  return {
    url: `${context.base.replace(/\/+$/, '')}${DEFAULT_OG_IMAGE.path}`,
    width: DEFAULT_OG_IMAGE.width,
    height: DEFAULT_OG_IMAGE.height,
    type: DEFAULT_OG_IMAGE.type,
    alt: context.locale === 'ar' ? `شعار ${context.brand}` : `${context.brand} logo`,
  };
}
