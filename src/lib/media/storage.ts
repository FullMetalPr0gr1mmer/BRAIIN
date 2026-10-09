import type { SupabaseClient } from '@supabase/supabase-js';
import { MEDIA_BUCKET } from '@schemas/media';

// The public `media` bucket (migration 0045). Only the SERVICE ROLE writes to it: the
// upload and replace routes put the re-encoded master, the delete route and the daily
// orphan sweep remove objects. No storage policy admits anon or authenticated, and a
// RESTRICTIVE belt refuses them outright; visitors read objects through the public URL,
// and pages reach that only through `/_image` (src/lib/media/storageUrl.ts).
//
// None of these throws: a storage failure is an answer (false), so a caller's order
// (upload, insert, compensate) always runs to its end.

/**
 * `<tenant>/<random id>_<w>x<h>.webp`. Never the uploaded file's name (that is
 * `display_name`, staff-only); a new id on every upload and every replace, so a cached
 * derivative of an old file can never be served for a new one.
 */
export function mediaObjectKey(tenantId: string, width: number, height: number): string {
  return `${tenantId}/${crypto.randomUUID()}_${width}x${height}.webp`;
}

/** One year: an object's bytes never change under its key. */
const OBJECT_CACHE_SECONDS = '31536000';

export async function uploadMediaObject(
  svc: SupabaseClient,
  key: string,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const { error } = await svc.storage.from(MEDIA_BUCKET).upload(key, bytes, {
      contentType: 'image/webp',
      upsert: false,
      cacheControl: OBJECT_CACHE_SECONDS,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function removeMediaObjects(
  svc: SupabaseClient,
  keys: readonly string[],
): Promise<boolean> {
  if (keys.length === 0) return true;
  try {
    const { error } = await svc.storage.from(MEDIA_BUCKET).remove([...keys]);
    return !error;
  } catch {
    return false;
  }
}
