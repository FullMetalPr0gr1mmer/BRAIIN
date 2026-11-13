import { z } from 'zod';
import { CRM_FILE_KINDS } from '@schemas/crmFiles';
import { defineAdminRoute } from '@/lib/admin/route';
import { writeAudit } from '@/lib/admin/audit';
import { NotFoundError } from '@/lib/admin/errors';
import { AuthorizationError } from '@/lib/authz/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { requireContactId } from '@/lib/crm/contacts';
import {
  CRM_FILE_DOWNLOAD_LIMITS,
  downloadFileObject,
  downloadName,
  fileObjectPathOf,
  kindOf,
  readFileAsCaller,
  removeFileObjects,
} from '@/lib/crm/files';

// One contact file (Admin v2 C16): its download (GET) and its removal (DELETE). `crm.files`,
// Admin only. The Join CV's way out (src/pages/api/admin/applications/[id]/cv.ts):
//
// GET, the one way a file leaves the private bucket:
//   live recheck → a slot (`crm-file-download`: 60 an hour per person, 120 per tenant,
//   fail-closed) → the row as the CALLER (RLS and the live check decide; a 404 otherwise) →
//   its object path as the service role, scoped to what the caller just read → an audit row
//   WRITTEN before the file (no row, no file) → the object → an attachment.
// Served so a browser never renders it: `attachment`, `nosniff`, `no-store`, and a CSP
// `sandbox` (kept by the security headers) for a URL opened in a tab. Not virus-scanned: the
// card says so beside every download (docs/security-exceptions.md, the C16 entry).
//
// DELETE: live recheck → the row as the caller (404) → its path → an attempt audit row
// WRITTEN (fail-closed) → the OBJECT first (if it cannot be removed the row stays, so the
// removal can be tried again; a row-first removal would leave a file nothing names until the
// sweep) → public.crm_file_remove, which checks the acting profile live → the outcome.
//
// Ids, the kind and the size only in the audit rows: never the file's name.

export const prerender = false;

function requireFileId(params: Record<string, string | undefined>): string {
  const fileId = params['fileId'];
  if (!fileId || !z.string().uuid().safeParse(fileId).success) throw new NotFoundError('file');
  return fileId;
}

export const GET = defineAdminRoute({
  cap: 'crm.files',
  handler: async ({ auth, sb, params }) => {
    const id = requireContactId(params);
    const fileId = requireFileId(params);

    await liveRecheck(auth);
    await claimPrivilegedOp(auth, 'crm-file-download', CRM_FILE_DOWNLOAD_LIMITS);

    const file = await readFileAsCaller(sb, auth, id, fileId);
    const kind = kindOf(file.content_type);
    if (!kind) throw new NotFoundError('file');
    const svc = serviceClient();
    const path = await fileObjectPathOf(svc, auth, id, fileId);
    if (!path) throw new NotFoundError('file');

    const logged = await writeAudit(sb, auth, {
      action: 'crm.file.download',
      entityType: 'contact',
      entityId: id,
      detail: { file: fileId, kind, bytes: file.bytes },
    });
    if (!logged) throw new AuthorizationError('crm.files', 'audit unavailable, refused');

    const blob = await downloadFileObject(svc, path);
    if (!blob) throw new Error('crm file download: object unavailable');

    return new Response(blob, {
      status: 200,
      headers: {
        'content-type': CRM_FILE_KINDS[kind].contentType,
        'content-disposition': `attachment; filename="${downloadName(file.name, kind)}"`,
        'content-length': String(blob.size),
        'cache-control': 'private, no-store, max-age=0, must-revalidate',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
      },
    });
  },
});

interface DoorError {
  code?: string;
}

export const DELETE = defineAdminRoute({
  cap: 'crm.files',
  handler: async ({ auth, sb, params }) => {
    const id = requireContactId(params);
    const fileId = requireFileId(params);

    await liveRecheck(auth);
    const file = await readFileAsCaller(sb, auth, id, fileId);
    const svc = serviceClient();
    const path = await fileObjectPathOf(svc, auth, id, fileId);
    if (!path) throw new NotFoundError('file');

    const logged = await writeAudit(sb, auth, {
      action: 'crm.file.delete.attempt',
      entityType: 'contact',
      entityId: id,
      detail: { file: fileId, kind: kindOf(file.content_type), bytes: file.bytes },
    });
    if (!logged) throw new AuthorizationError('crm.files', 'audit unavailable, refused');

    const outcome = (status: string, code: string | null = null) =>
      writeAudit(sb, auth, {
        action: 'crm.file.delete.outcome',
        entityType: 'contact',
        entityId: id,
        detail: { file: fileId, status, code },
      });

    // The object first: if it cannot be removed the row stays, and the removal can be retried.
    if (!(await removeFileObjects(svc, [path]))) {
      await outcome('failed', 'storage');
      throw new Error('crm file removal: the object could not be removed');
    }

    let error: DoorError | null = null;
    try {
      ({ error } = await svc.rpc('crm_file_remove', {
        p_tenant: auth.tenantId,
        p_contact: id,
        p_file: fileId,
        p_actor: auth.userId,
      }));
    } catch {
      error = {};
    }
    if (error) {
      await outcome(
        error.code === 'P0002' ? 'not_found' : error.code === '42501' ? 'refused' : 'failed',
        error.code ?? null,
      );
      if (error.code === 'P0002') throw new NotFoundError('file');
      if (error.code === '42501') {
        throw new AuthorizationError('crm.files', 'the database refused this person');
      }
      throw new Error(`crm_file_remove: ${error.code ?? 'no code'}`);
    }

    await outcome('ok');
    return { removed: true };
  },
});
