import { z } from 'zod';

// Contact files (Admin v2 C16, crm.md §12 "Files"): what a file kept with a contact may be, and
// the one input its upload takes. A module of its own, so the other CRM slices' edits to crm.ts
// and this one's never meet. Migration 0140's CHECKs and bucket refuse the same: the kinds, the
// size, the name.

/**
 * The five kinds a contact file may be, decided by its BYTES (src/lib/crm/fileSniff.ts), never
 * by the browser's type or the name's extension. No SVG (it can carry script), no legacy Office
 * format (its macros cannot be checked without parsing the whole file), no archive.
 */
export const CRM_FILE_KINDS = {
  pdf: { contentType: 'application/pdf', extension: 'pdf', label: 'PDF' },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
    label: 'Word document',
  },
  png: { contentType: 'image/png', extension: 'png', label: 'PNG image' },
  jpeg: { contentType: 'image/jpeg', extension: 'jpg', label: 'JPEG image' },
  webp: { contentType: 'image/webp', extension: 'webp', label: 'WebP image' },
} as const;
export type CrmFileKind = keyof typeof CRM_FILE_KINDS;

/** What a file input offers (a hint only: the bytes decide). */
export const CRM_FILE_ACCEPT =
  '.pdf,.docx,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The largest file (the bucket's own limit, 0140). */
export const CRM_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** What the multipart form may add around the file: the name field and the part headers. */
export const CRM_FILE_FORM_OVERHEAD_BYTES = 16 * 1024;
/** How many files one contact keeps (app.crm_files_cap(), 0140). */
export const CRM_FILES_PER_CONTACT = 20;
/** The longest name staff may give a file. */
export const CRM_FILE_NAME_MAX = 120;

const NO_CONTROL = /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]*$/u;

/**
 * The name staff see for a file: its own name as their computer had it, or one they type, with
 * no folder in it. Never part of the object path. 0140's CHECK refuses the same characters.
 */
export const CrmFileNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the file a name.')
  .max(CRM_FILE_NAME_MAX, `Keep the name to ${CRM_FILE_NAME_MAX} characters.`)
  .regex(NO_CONTROL, 'Use letters, numbers and punctuation only.')
  .regex(/^[^/\\]+$/, 'A file name cannot hold a slash.');

/** POST /api/admin/crm/contacts/[id]/files: the form's text field (the file is its own part). */
export const CrmFileUploadSchema = z.object({ name: CrmFileNameSchema }).strict();
export type CrmFileUpload = z.infer<typeof CrmFileUploadSchema>;
