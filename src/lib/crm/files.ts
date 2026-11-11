import type { SupabaseClient } from '@supabase/supabase-js';
import { CRM_FILE_KINDS, type CrmFileKind } from '@schemas/crmFiles';
import type { AuthContext } from '@/lib/auth/types';
import type { RateLimitOptions } from '@/lib/admin/rateLimit';
import { NotFoundError, ValidationError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';

// Contact files (Admin v2 C16, migration 0140): the private bucket `crm-files` and the rows that
// name its objects. Only the SERVICE ROLE reaches the bucket: the upload route writes, the
// download route reads, the removal route, the person erasure (after the database has erased,
// C16 review) and the sweep delete. Every
// function here that touches Storage or an object path takes the service client, and
// tests/lib/contactFileGrants.spec.ts names every file that calls them.
//
// Staff tokens read a file's row (name, type, size, when, who) under RLS and the live check,
// never its object path (0140's column grant): a route proves the caller may see the file by
// reading it as the caller first, then reads its path as the service role.

export const CRM_FILES_BUCKET = 'crm-files';

/** A file's row as staff read it (0140's column grant): never its path. */
export const CRM_FILE_FIELDS = [
  'id',
  'contact_id',
  'name',
  'content_type',
  'bytes',
  'created_at',
  'created_by',
] as const;
export const CRM_FILE_COLUMNS = CRM_FILE_FIELDS.join(',');

export interface CrmFile {
  id: string;
  contact_id: string;
  name: string;
  content_type: string;
  bytes: number;
  created_at: string;
  created_by: string | null;
}

/** A row cut to the named fields (whatever else a database answer carries never leaves). */
export function pickFile(row: Record<string, unknown>): CrmFile {
  return {
    id: String(row['id']),
    contact_id: String(row['contact_id']),
    name: typeof row['name'] === 'string' ? row['name'] : '',
    content_type: typeof row['content_type'] === 'string' ? row['content_type'] : '',
    bytes: typeof row['bytes'] === 'number' ? row['bytes'] : 0,
    created_at: typeof row['created_at'] === 'string' ? row['created_at'] : '',
    created_by: typeof row['created_by'] === 'string' ? row['created_by'] : null,
  };
}

/** The kind a stored content type is (the sniff stored it), or null for one this never writes. */
export function kindOf(contentType: string): CrmFileKind | null {
  for (const [kind, spec] of Object.entries(CRM_FILE_KINDS)) {
    if (spec.contentType === contentType) return kind as CrmFileKind;
  }
  return null;
}

/**
 * `<tenant>/<contact>/<random>.<ext>`. Never the uploaded name: it is personal data, and an
 * object path is not encrypted. The random part is the row's id, so a path learned from one
 * file cannot be used to guess another's.
 */
export function fileObjectPath(
  tenantId: string,
  contactId: string,
  fileId: string,
  kind: CrmFileKind,
): string {
  return `${tenantId}/${contactId}/${fileId}.${CRM_FILE_KINDS[kind].extension}`;
}

/**
 * The download's file name: an ASCII slug of the name staff gave it (a header carries no
 * other), then the kind's own extension; `file.<ext>` when nothing is left (an Arabic name).
 * Never the name as typed: a quote or a line break in a header is how responses are split.
 */
export function downloadName(name: string, kind: CrmFileKind): string {
  const ext = CRM_FILE_KINDS[kind].extension;
  const stem = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return `${stem || 'file'}.${ext}`;
}

/** Adding files: real work stays well inside it; a script filling the bucket does not. */
export const CRM_FILE_UPLOAD_LIMITS: RateLimitOptions = {
  perUser: 60,
  perTenant: 200,
  windowMinutes: 24 * 60,
};

/** Downloading files: the CV download's numbers (a reviewer opens many; a scraper more). */
export const CRM_FILE_DOWNLOAD_LIMITS: RateLimitOptions = {
  perUser: 60,
  perTenant: 120,
  windowMinutes: 60,
};

// ── Storage (the service client only) ───────────────────────────────────────────────────
// None of these throws: a storage failure is an answer (false / null), so a caller's order
// (upload, insert, compensate; object first, then the row) always runs to its end.

/**
 * Stores the file under the content type the SNIFF decided, never the browser's: the bucket's
 * type list checks this one. `slice` re-types the blob without copying its bytes.
 */
export async function uploadFileObject(
  svc: SupabaseClient,
  path: string,
  file: Blob,
  kind: CrmFileKind,
): Promise<boolean> {
  const { contentType } = CRM_FILE_KINDS[kind];
  try {
    const { error } = await svc.storage
      .from(CRM_FILES_BUCKET)
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

export async function removeFileObjects(
  svc: SupabaseClient,
  paths: readonly string[],
): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    const { error } = await svc.storage.from(CRM_FILES_BUCKET).remove([...paths]);
    return !error;
  } catch {
    return false;
  }
}

export async function downloadFileObject(svc: SupabaseClient, path: string): Promise<Blob | null> {
  try {
    const { data, error } = await svc.storage.from(CRM_FILES_BUCKET).download(path);
    return error || !data ? null : data;
  } catch {
    return null;
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────

/** A file of a contact as the CALLER reads it (RLS and the live check decide), or a 404. */
export async function readFileAsCaller(
  sb: SupabaseClient,
  auth: AuthContext,
  contactId: string,
  fileId: string,
): Promise<CrmFile> {
  const { data, error } = await sb
    .from('crm_contact_files')
    .select(CRM_FILE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('contact_id', contactId)
    .eq('id', fileId)
    .maybeSingle();
  if (error) throw new Error(`crm_contact_files: ${error.code ?? 'no code'}`);
  if (!data) throw new NotFoundError('file');
  return pickFile(data as unknown as Record<string, unknown>);
}

/** A contact's files, newest first, as the caller reads them. */
export async function listFilesAsCaller(
  sb: SupabaseClient,
  auth: AuthContext,
  contactId: string,
): Promise<CrmFile[]> {
  const { data, error } = await sb
    .from('crm_contact_files')
    .select(CRM_FILE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(100);
  if (error) throw new Error(`crm_contact_files: ${error.code ?? 'no code'}`);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(pickFile);
}

/**
 * One file's object path, as the service role, scoped to the tenant and contact the caller's
 * own read already proved it may see. Null when the row is gone meanwhile.
 */
export async function fileObjectPathOf(
  svc: SupabaseClient,
  auth: AuthContext,
  contactId: string,
  fileId: string,
): Promise<string | null> {
  const { data, error } = await svc
    .from('crm_contact_files')
    .select('object_path')
    .eq('tenant_id', auth.tenantId)
    .eq('contact_id', contactId)
    .eq('id', fileId)
    .maybeSingle();
  if (error) throw new Error(`crm_contact_files: ${error.code ?? 'no code'}`);
  const path = (data as { object_path?: unknown } | null)?.object_path;
  return typeof path === 'string' ? path : null;
}

/**
 * A person's files for their erasure (Admin v2 C16): the contact's own and its merge
 * tombstones' (C12), as the service role, scoped to the caller's tenant. Ids and paths only.
 */
export async function personFiles(
  svc: SupabaseClient,
  tenantId: string,
  contactId: string,
): Promise<{ id: string; object_path: string }[]> {
  const { data: tombstones, error: tombError } = await svc
    .from('crm_contacts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('merged_into', contactId);
  if (tombError) throw new Error(`crm_contacts: ${tombError.code ?? 'no code'}`);
  const ids = [
    contactId,
    ...((tombstones ?? []) as { id?: unknown }[])
      .map((t) => t.id)
      .filter((id): id is string => typeof id === 'string'),
  ];
  const { data, error } = await svc
    .from('crm_contact_files')
    .select('id,object_path')
    .eq('tenant_id', tenantId)
    .in('contact_id', ids);
  if (error) throw new Error(`crm_contact_files: ${error.code ?? 'no code'}`);
  return ((data ?? []) as { id?: unknown; object_path?: unknown }[])
    .filter(
      (r): r is { id: string; object_path: string } =>
        typeof r.id === 'string' && typeof r.object_path === 'string',
    )
    .map((r) => ({ id: r.id, object_path: r.object_path }));
}

/**
 * How many files a person has (the erasure preview's count), as the service role. A read that
 * fails THROWS (C16 review, C16-SEC-3): the preview then answers an error the dialog shows,
 * never a count of 0 the Admin would take for "no files" before an erasure that cannot be
 * undone.
 */
export async function countPersonFiles(
  svc: SupabaseClient,
  tenantId: string,
  contactId: string,
): Promise<number> {
  return (await personFiles(svc, tenantId, contactId)).length;
}

/**
 * What a door's refusal means. 42501: the database refused the person (a demotion between the
 * live recheck and the door); P0002: the contact or the file is gone; 23514: the ceiling or a
 * CHECK (a name the schema let through cannot reach one).
 */
export function fileDoorError(error: { code?: string; message?: string }, what: string): Error {
  if (error.code === '42501') return new AuthorizationError('crm.files', 'the database refused');
  if (error.code === 'P0002') return new NotFoundError(what);
  if (error.code === '23514' && /crm_contact_files_cap/.test(error.message ?? '')) {
    return new ValidationError(
      'A contact keeps up to 20 files. Remove one before adding another.',
      'file',
    );
  }
  if (error.code === '23514' || error.code === '22023') {
    return new ValidationError(
      'This file could not be added. Check its name and try again.',
      'name',
    );
  }
  return new Error(`${what}: ${error.code ?? 'no code'}`);
}
