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
 * `application/octet-stream` for a .docx.
 */
export async function uploadCv(
  svc: SupabaseClient,
  path: string,
  file: Blob,
  kind: CvKind,
): Promise<boolean> {
  const typed = new Blob([file], { type: CV_KINDS[kind].contentType });
  const { error } = await svc.storage.from(CV_BUCKET).upload(path, typed, {
    contentType: CV_KINDS[kind].contentType,
    upsert: false,
    cacheControl: '0',
  });
  return !error;
}

export async function removeCvs(svc: SupabaseClient, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const { error } = await svc.storage.from(CV_BUCKET).remove([...paths]);
  return !error;
}

export async function downloadCv(svc: SupabaseClient, path: string): Promise<Blob | null> {
  const { data, error } = await svc.storage.from(CV_BUCKET).download(path);
  return error || !data ? null : data;
}
