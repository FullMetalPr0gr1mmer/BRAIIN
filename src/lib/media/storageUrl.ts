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

/** The admin thumbnail's width: a width `/_image` serves (TRANSFORM_WIDTHS). */
export const THUMB_WIDTH = 320;

/**
 * A thumbnail of an uploaded image through `/_image`: 320 px wide (or the image's own width
 * when it is narrower), WebP, at the stored aspect, so the `/_image` guard accepts it.
 */
export function storageThumbUrl(key: string, base: string = PUBLIC_SUPABASE_URL): string | null {
  const parsed = parseStorageKey(key);
  const href = mediaPublicUrl(key, base);
  if (!parsed || href === null) return null;
  const w = Math.min(THUMB_WIDTH, parsed.width);
  const h = Math.max(1, Math.round((w * parsed.height) / parsed.width));
  return `/_image?${new URLSearchParams({ href, w: String(w), h: String(h), f: 'webp' })}`;
}
