import type { SupabaseClient } from '@supabase/supabase-js';
import { CV_KINDS, type CvKind } from '@schemas/application';

// The CV bucket (migration 0029): private, ≤ 10 MB, PDF or .docx. Only the SERVICE ROLE
// reaches it — the apply endpoint writes, the admin download and the retention job read
// and delete — so every function here takes the service client and nothing else does.

export const CV_BUCKET = 'applications';

/**
 * `<tenant>/<application>/<random>.<ext>`. Never the uploaded file name: it is personal
 * data, and an object path is not encrypted. The random segment means a path learned from
 * one row cannot be used to guess another's.
 */
export function cvObjectPath(tenantId: string, applicationId: string, kind: CvKind): string {
  return `${tenantId}/${applicationId}/${crypto.randomUUID()}.${CV_KINDS[kind].extension}`;
}

/**
 * Stores the file under the content type the SNIFF decided, never the browser's: the
 * bucket's MIME allowlist checks this type, and a browser on some systems sends
 * `application/octet-stream` for a .docx. `slice` re-types the blob without copying its
 * bytes (a copy of 10 MB is CPU time the free plan does not have).
 *
 * None of these throws: a storage failure is an answer (false / null), so a caller's
 * order — upload, insert, compensate — always runs to its end.
 */
export async function uploadCv(
  svc: SupabaseClient,
  path: string,
  file: Blob,
  kind: CvKind,
): Promise<boolean> {
  const { contentType } = CV_KINDS[kind];
  try {
    const { error } = await svc.storage
      .from(CV_BUCKET)
      .upload(path, file.slice(0, file.size, contentType), {
        contentType,
        upsert: false,
        cacheControl: '0',
      });
    return !error;
  } catch {
    return false;
  }
}

export async function removeCvs(svc: SupabaseClient, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await svc.storage.from(CV_BUCKET).remove([...paths]);
    return !error;
  } catch {
    return false;
  }
}

export async function downloadCv(svc: SupabaseClient, path: string): Promise<Blob | null> {
  try {
    const { data, error } = await svc.storage.from(CV_BUCKET).download(path);
    return error || !data ? null : data;
  } catch {
    return null;
  }
}
