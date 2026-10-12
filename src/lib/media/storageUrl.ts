import type { ImageMetadata } from 'astro';
import { PUBLIC_SUPABASE_URL } from 'astro:env/client';
import { MEDIA_BUCKET, parseStorageKey } from '@schemas/media';

// Where an uploaded image lives on the web (Admin v2 U3): the public `media` bucket of this
// build's Supabase project. Nothing renders that URL directly: pages and the admin reach it
// through same-origin `/_image` (so img-src needs no new origin), and Astro's image endpoint
// fetches it only because `image.remotePatterns` names exactly this bucket path
// (astro.config.mjs, scripts/media-remote-patterns.mjs). The `/_image` guard
// (src/lib/http/imageGuard.ts) recognises the same prefix.

/** `https://<project>.supabase.co/storage/v1/object/public/media/`, or null if unset. */
export function mediaBucketPrefix(base: string = PUBLIC_SUPABASE_URL): string | null {
  try {
    return `${new URL(base).origin}/storage/v1/object/public/${MEDIA_BUCKET}/`;
  } catch {
    return null;
  }
}

/** The public URL of an uploaded image's object, or null for anything that is not a key. */
export function mediaPublicUrl(key: string, base: string = PUBLIC_SUPABASE_URL): string | null {
  if (!parseStorageKey(key)) return null;
  const prefix = mediaBucketPrefix(base);
  return prefix === null ? null : `${prefix}${key}`;
}

/**
 * An uploaded image in the shape of a bundled one, for `<Picture>` and `getImage()`
 * (src/lib/media/resolve.ts). Astro then builds its transform URLs exactly as for a still
 * shipped with the site: always the same-origin `/_image` (never the bucket's URL in the
 * page, so img-src needs no new origin), and a call site that passes only a width gets the
 * height from the stored aspect. The size is the key's, which the 0045 CHECK holds equal to
 * the row's, and which the `/_image` guard reads too.
 */
export function uploadedImage(
  key: string,
  base: string = PUBLIC_SUPABASE_URL,
): ImageMetadata | null {
  const parsed = parseStorageKey(key);
  const src = mediaPublicUrl(key, base);
  if (!parsed || src === null) return null;
  return { src, width: parsed.width, height: parsed.height, format: 'webp' };
}

/**
 * The size of the uploaded image a `/_image` request names, or null when its `href` is not
 * one of this build's bucket keys (src/lib/http/imageGuard.ts). Read from the key, so the
 * guard bounds a transform without a database read.
 */
export function uploadedImageSize(
  href: string,
  base: string = PUBLIC_SUPABASE_URL,
): { width: number; height: number } | null {
  const prefix = mediaBucketPrefix(base);
  if (prefix === null || !href.startsWith(prefix)) return null;
  const parsed = parseStorageKey(href.slice(prefix.length));
  return parsed ? { width: parsed.width, height: parsed.height } : null;
}

/**
 * The format `<Picture>` falls back to (its `<img src>` and `srcset`) for this image: WebP for
 * an upload. Left to itself Astro gives every format but gif, svg and jpeg a PNG fallback
 * (components/Picture.astro `defaultFallbackFormat`), which for an upload meant a full-size
 * PNG encode of a WebP master, and a set of transformations nothing needs. A still keeps
 * Astro's rule (undefined here), so its markup is unchanged.
 */
export function uploadFallbackFormat(src: ImageMetadata): 'webp' | undefined {
  return uploadedImageSize(src.src) === null ? undefined : 'webp';
}

/** The admin thumbnail's width: a width `/_image` serves (TRANSFORM_WIDTHS). */
export const THUMB_WIDTH = 320;

/**
 * A thumbnail of an uploaded image through `/_image`: 320 px wide (or the image's own width
 * when it is narrower), WebP, at the stored aspect, so the `/_image` guard accepts it. The
 * four parameters `getImage()` would emit, written here so the media resource (an API
 * module) needs no `astro:assets`; tests/lib/mediaDelivery.spec.ts holds it to the guard.
 */
export function storageThumbUrl(key: string, base: string = PUBLIC_SUPABASE_URL): string | null {
  const parsed = parseStorageKey(key);
  const href = mediaPublicUrl(key, base);
  if (!parsed || href === null) return null;
  const w = Math.min(THUMB_WIDTH, parsed.width);
  const h = Math.max(1, Math.round((w * parsed.height) / parsed.width));
  return `/_image?${new URLSearchParams({ href, w: String(w), h: String(h), f: 'webp' })}`;
}
