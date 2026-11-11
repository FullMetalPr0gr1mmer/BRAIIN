import { CRM_FILE_KINDS, CRM_FILE_MAX_BYTES, CrmFileNameSchema } from '@schemas/crmFiles';

// The Files card's words and checks (Admin v2 C16), pure so they are tested without a browser.
// The checks here are the browser's courtesy only: the route checks the size, the name and the
// BYTES again, whatever this says.

/** A file as the card shows it (GET /api/admin/crm/contacts/[id]/files). */
export interface FileItem {
  id: string;
  name: string;
  content_type: string;
  bytes: number;
  created_at: string;
  created_by: string | null;
}

/** "PDF", "Word document", "PNG image"…, from the type the sniff stored. */
export function fileKindLabel(contentType: string): string {
  for (const spec of Object.values(CRM_FILE_KINDS)) {
    if (spec.contentType === contentType) return spec.label;
  }
  return 'File';
}

/** A size in words: "820 KB", "2.4 MB" (digits as they are, P-12). */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The name a chosen file starts with: its own, without a folder, cut to what may be stored. */
export function defaultFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  return base
    .replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '')
    .trim()
    .slice(0, 120);
}

/** Why a chosen file and its name cannot be sent, or null when they can. */
export function fileProblem(
  file: { size: number } | null,
  name: string,
): { field: 'file' | 'name'; message: string } | null {
  if (!file) return { field: 'file', message: 'Choose a file first.' };
  if (file.size === 0) return { field: 'file', message: 'This file is empty.' };
  if (file.size > CRM_FILE_MAX_BYTES) {
    return { field: 'file', message: 'This file is larger than 10 MB. Choose a smaller one.' };
  }
  const parsed = CrmFileNameSchema.safeParse(name);
  if (!parsed.success) {
    return { field: 'name', message: parsed.error.issues[0]?.message ?? 'Check the name.' };
  }
  return null;
}
