import { getImage } from 'astro:assets';
import type { ImageRef } from '@/lib/media/resolve';

// A share image (og:image, twitter:image, JSON-LD `image`) from a picture the site already
// renders: the same-origin `/_image` JPEG at the picture's own aspect, at most 1200 px wide,
// made absolute on the site origin (crawlers need an absolute URL). Posters and case-study
// banners have shipped this way since UI v2; an SEO share image from the media library
// (Admin v2 U10, `entity_seo.og_media_id`, `seo_defaults.default_og_media_id`) is the same.
// Native aspect, never a 1200x630 crop: the `/_image` guard (src/lib/http/imageGuard.ts)
// refuses a height off the asset's aspect, and every platform letterboxes or crops itself.

export const SHARE_IMAGE_MAX_WIDTH = 1200;

export async function shareImageUrl(ref: ImageRef, base: string): Promise<string> {
  const image = await getImage({
    src: ref.src,
    width: Math.min(SHARE_IMAGE_MAX_WIDTH, ref.width),
    format: 'jpg',
  });
  return new URL(image.src, `${base.replace(/\/+$/, '')}/`).href;
}
