import { AdminApiError, describeError } from '@/lib/admin/client';

// Why an upload or a replace did not land, in the editor's words (Admin v2 U4). The upload
// routes (U3) answer each refusal with a stable code and a `detail` already written for the
// editor (src/lib/media/upload.ts REFUSALS, checkLength, NOT_SET_UP): those are shown as they
// are. The kernel's own refusals get words that fit an upload: the daily cap is a day, not
// the generic "try again in an hour"; a role is named; a replace that lost a race says so.

export interface UploadRefusalInfo {
  /** The HTTP status, or 0 when the request never got an answer. */
  status: number;
  error: string;
  detail?: string | undefined;
}

/** The codes whose `detail` the upload routes wrote for the editor. */
const SAY_DETAIL = new Set([
  'unsupported-type',
  'invalid-image',
  'image-too-large',
  'image-too-thin',
  'too-large',
  'length-required',
  'bad-length',
  'empty-file',
  'not-set-up',
  'storage-failed',
]);

export const LIMIT_TEXT =
  "You have reached today's upload limit (50 pictures a day per person, 100 for the team). Try again tomorrow.";
export const ROLE_TEXT = 'Your role does not allow uploading.';
export const CONFLICT_TEXT = 'Someone else changed this picture. Reload it and try again.';
export const NETWORK_TEXT = 'The connection dropped before the picture was sent. Try again.';

export function refusalText(
  refusal: UploadRefusalInfo,
  op: 'upload' | 'replace' = 'upload',
): string {
  if (SAY_DETAIL.has(refusal.error) && refusal.detail) return refusal.detail;
  if (refusal.status === 429 || refusal.error === 'rate-limit') return LIMIT_TEXT;
  if (refusal.status === 403) return ROLE_TEXT;
  if (refusal.status === 409 && op === 'replace') return CONFLICT_TEXT;
  if (refusal.status === 0) return NETWORK_TEXT;
  return describeError(
    new AdminApiError({ error: refusal.error, status: refusal.status, detail: refusal.detail }),
  );
}
