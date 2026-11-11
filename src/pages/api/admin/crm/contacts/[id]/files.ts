import {
  CRM_FILE_FORM_OVERHEAD_BYTES,
  CRM_FILE_KINDS,
  CRM_FILE_MAX_BYTES,
  CrmFileUploadSchema,
} from '@schemas/crmFiles';
import { defineAdminRoute, json } from '@/lib/admin/route';
import { ValidationError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { claimPrivilegedOp } from '@/lib/admin/rateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { getContact, requireContactId } from '@/lib/crm/contacts';
import { sniffContactFile, sniffRefusalWords } from '@/lib/crm/fileSniff';
import {
  CRM_FILE_UPLOAD_LIMITS,
  fileDoorError,
  fileObjectPath,
  listFilesAsCaller,
  pickFile,
  removeFileObjects,
  uploadFileObject,
} from '@/lib/crm/files';

// A contact's files (Admin v2 C16, crm.md §12): the list (GET) and a new file (POST).
// `crm.files`, Admin only (CLAUDE.md §5). Immediate (P-3: CRM data is never staged).
//
// GET: the contact as the caller (RLS; a tombstone or an unseen one is a 404), then its files
// as the caller (RLS and the live check decide; never a file's object path). Audited queued
// (`crm.file.list`, the count): it shows names and sizes, never a file's content.
//
// POST (multipart: `file` and `name`), each step refusing before the next costs anything:
//   Content-Length ≤ 10 MiB + the form (411 / 413) → live recheck (the service role writes
//   the object, so a demoted Admin is refused now) → the contact as the caller (404) → the
//   form → the name (Zod, 422) → the BYTES sniffed (422 in plain words: never the browser's
//   type or the extension) → a slot under the day's limit (`crm-file-upload`, after the sniff
//   so a refused file costs none) → the object, under `<tenant>/<contact>/<id>.<ext>` and the
//   sniffed type, as the service role → public.crm_file_add, which checks the acting profile
//   live, the contact (not a tombstone) and the ceiling of 20; refused, the object is removed
//   again, and whatever that misses the sweep removes (cron:crm-file-orphans).
// The audit row (`crm.file.upload`) names the kind and the size, never the file's name.

export const prerender = false;

const MAX_BODY = CRM_FILE_MAX_BYTES + CRM_FILE_FORM_OVERHEAD_BYTES;

export const GET = defineAdminRoute({
  cap: 'crm.files',
  handler: async ({ auth, sb, params, audit }) => {
    const id = requireContactId(params);
    await getContact(sb, auth, id, 'id');
    const files = await listFilesAsCaller(sb, auth, id);
    audit({
      action: 'crm.file.list',
      entityType: 'contact',
      entityId: id,
      detail: { files: files.length },
    });
    return { files };
  },
});

function refusal(status: number, error: string, detail: string): Response {
  return json({ ok: false, error, detail, field: 'file' }, status);
}

export const POST = defineAdminRoute({
  cap: 'crm.files',
  handler: async ({ auth, sb, params, request, audit }) => {
    const id = requireContactId(params);

    const lengthHeader = request.headers.get('content-length');
    if (lengthHeader === null) {
      return refusal(
        411,
        'length-required',
        'We need to know the file size first. Please try again.',
      );
    }
    if (!/^\d{1,12}$/.test(lengthHeader.trim())) {
      return refusal(400, 'bad-length', 'The file size could not be read.');
    }
    if (Number(lengthHeader.trim()) > MAX_BODY) {
      return refusal(413, 'too-large', 'This file is larger than 10 MB. Choose a smaller one.');
    }
    if (!supabaseConfigured()) {
      return refusal(503, 'not-set-up', 'Files are not set up on this site yet.');
    }

    await liveRecheck(auth);
    await getContact(sb, auth, id, 'id');

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return refusal(400, 'bad-form', 'The file could not be read. Please try again.');
    }
    const file = form.get('file');
    const rawName = form.get('name');
    if (!(file instanceof Blob)) throw new ValidationError('Choose a file first.', 'file');
    const parsed = CrmFileUploadSchema.safeParse({
      name: typeof rawName === 'string' ? rawName : '',
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? 'Check the name.', 'name');
    }
    if (file.size > CRM_FILE_MAX_BYTES) {
      return refusal(413, 'too-large', 'This file is larger than 10 MB. Choose a smaller one.');
    }

    const sniff = await sniffContactFile(file);
    if (!sniff.ok) {
      return json(
        {
          ok: false,
          error: 'validation',
          detail: sniffRefusalWords(sniff.reason),
          field: 'file',
          reason: sniff.reason,
        },
        422,
      );
    }

    await claimPrivilegedOp(auth, 'crm-file-upload', CRM_FILE_UPLOAD_LIMITS);

    const svc = serviceClient();
    const fileId = crypto.randomUUID();
    const path = fileObjectPath(auth.tenantId, id, fileId, sniff.kind);
    if (!(await uploadFileObject(svc, path, file, sniff.kind))) {
      return refusal(502, 'storage-failed', 'We could not save the file. Please try again.');
    }

    let data: unknown = null;
    let error: { code?: string; message?: string } | null = null;
    try {
      ({ data, error } = await svc.rpc('crm_file_add', {
        p_tenant: auth.tenantId,
        p_contact: id,
        p_file: {
          id: fileId,
          object_path: path,
          name: parsed.data.name,
          content_type: CRM_FILE_KINDS[sniff.kind].contentType,
          bytes: file.size,
        },
        p_actor: auth.userId,
      }));
    } catch {
      error = {};
    }
    if (error || !data || typeof data !== 'object') {
      // The row was refused: the object goes again (the sweep catches a removal that fails).
      await removeFileObjects(svc, [path]);
      throw fileDoorError(error ?? {}, 'contact');
    }

    const added = pickFile(data as Record<string, unknown>);
    audit({
      action: 'crm.file.upload',
      entityType: 'contact',
      entityId: id,
      detail: { file: added.id, kind: sniff.kind, bytes: added.bytes },
    });
    return { file: added };
  },
});
