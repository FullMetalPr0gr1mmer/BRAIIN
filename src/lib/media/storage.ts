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
 * The storage the library's meter measures against: the Supabase Free plan's 1 GB, which
 * this bucket shares with the CV bucket (`applications`). A plan change is an owner item.
 */
export const MEDIA_STORAGE_QUOTA_BYTES = 1_073_741_824;

/**
 * `<tenant>/<random id>_<w>x<h>.webp`. Never the uploaded file's name (that is
 * `display_name`, staff-only); a new id on every upload and every replace, so a cached
 * derivative of an old file can never be served for a new one.
 */
export function mediaObjectKey(tenantId: string, width: number, height: number): string {
  return `${tenantId}/${crypto.randomUUID()}_${width}x${height}.webp`;
}

/**
 * How long Supabase's CDN (and a browser) may keep an object: one hour. An object's bytes
 * never change under its key, but it can be DELETED (an erasure request, a portrait taken
 * down), and on the Free plan a delete does not clear the CDN's copy: only this lifetime
 * ends it. A year here meant a deleted file stayed on the web for a year. The cost is a
 * revalidation an hour, and only `/_image` fetches objects (its derivatives of uploads keep
 * the same hour: src/lib/http/imageEndpoint.ts).
 */
export const MEDIA_OBJECT_CACHE_SECONDS = 3600;

export async function uploadMediaObject(
  svc: SupabaseClient,
  key: string,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const { error } = await svc.storage.from(MEDIA_BUCKET).upload(key, bytes, {
      contentType: 'image/webp',
      upsert: false,
      cacheControl: String(MEDIA_OBJECT_CACHE_SECONDS),
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

/** What became of a file whose row let go of it. */
export type ObjectRemoval = 'removed' | 'remove-failed' | 'still-named' | 'lookup-failed';

/**
 * Removes an uploaded image's object now, unless a row still names it. 0045's unique index
 * keeps two `storage` rows from naming one key, but this asks the same question the daily
 * sweep asks (any row, as the service role), so a file a page still shows is never removed
 * here; a lookup that fails keeps the file too, and the sweep decides later.
 */
export async function removeObjectIfUnnamed(
  svc: SupabaseClient,
  key: string,
): Promise<ObjectRemoval> {
  try {
    const { count, error } = await svc
      .from('media_assets')
      .select('id', { count: 'exact', head: true })
      .eq('storage_path', key);
    if (error || typeof count !== 'number') return 'lookup-failed';
    if (count > 0) return 'still-named';
  } catch {
    return 'lookup-failed';
  }
  return (await removeMediaObjects(svc, [key])) ? 'removed' : 'remove-failed';
}
