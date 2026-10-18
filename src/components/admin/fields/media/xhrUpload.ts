import { encodeMediaMeta, MEDIA_META_HEADER } from '@schemas/media';
import type { UploadRefusalInfo } from './refusalText';

// Sending a picture with progress (Admin v2 U4). U3's wire contract: the file is the raw
// request BODY, its details one header (`x-media-meta`, encodeMediaMeta: base64url JSON), the
// CSRF token the `x-csrf-token` header (read from the layout's meta tag, as adminFetch does;
// client.ts is the sign-in page's chunk and does not grow). XMLHttpRequest rather than fetch,
// because only XHR reports upload progress; a raw body reports it as well as a form does.
//
// The answer is the route's envelope: the row on success, else `{status, error, detail}`
// (refusalText.ts words it). A 401 sends the page to sign in, as adminFetch does. Nothing
// here makes a URL of the file: img-src has no blob: (CSP), so there is no local preview.

export type MediaRow = Record<string, unknown>;

export type UploadResult = { ok: true; row: MediaRow } | { ok: false; refusal: UploadRefusalInfo };

export interface UploadOptions {
  /** Called with the share sent so far, 0 to 1. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** What an upload's header carries (MediaUploadMetaSchema). */
export interface UploadMeta {
  alt: { en: string; ar: string };
  displayName?: string;
  tags?: string[];
  folder?: string;
}

/** What a replace's header carries (MediaReplaceMetaSchema). */
export interface ReplaceMeta {
  version: number;
  displayName?: string;
  removePrevious?: boolean;
}

/** An aborted send: the caller asked for it (Cancel), so it is not a failure to show. */
export class UploadAborted extends Error {
  constructor() {
    super('The upload was cancelled.');
    this.name = 'UploadAborted';
  }
}

function csrfToken(): string {
  const doc = (globalThis as { document?: Document }).document;
  return doc?.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';
}

/**
 * The name the library shows for a file: its own name, without anything the schema refuses
 * (control characters, line separators, slashes), trimmed and cut to 200 characters by code
 * point; undefined when nothing is left.
 */
export function displayNameOf(name: string): string | undefined {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\]/gu, ' ').trim();
  const cut = Array.from(clean).slice(0, 200).join('').trim();
  return cut === '' ? undefined : cut;
}

function send(
  url: string,
  file: Blob,
  meta: unknown,
  options: UploadOptions,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UploadAborted());
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('x-csrf-token', csrfToken());
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader(MEDIA_META_HEADER, encodeMediaMeta(meta));

    const onAbort = () => xhr.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => options.signal?.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = (event: ProgressEvent) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      done();
      if (xhr.status === 401) {
        const here = (globalThis as { location?: Location }).location;
        if (here) here.href = `/admin/login?next=${encodeURIComponent(here.pathname)}`;
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(xhr.responseText || '{}')) as Record<string, unknown>;
      } catch {
        // Not JSON (a proxy's error page): the status still says what happened.
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload['ok'] !== false) {
        options.onProgress?.(1);
        resolve({ ok: true, row: (payload['data'] ?? payload) as MediaRow });
        return;
      }
      resolve({
        ok: false,
        refusal: {
          status: xhr.status,
          error: typeof payload['error'] === 'string' ? payload['error'] : 'request-failed',
          detail: typeof payload['detail'] === 'string' ? payload['detail'] : undefined,
        },
      });
    };
    xhr.onerror = () => {
      done();
      resolve({ ok: false, refusal: { status: 0, error: 'network' } });
    };
    xhr.onabort = () => {
      done();
      reject(new UploadAborted());
    };
    xhr.send(file);
  });
}

/** POST /api/admin/media/upload: a new picture. */
export function uploadImage(
  file: Blob,
  meta: UploadMeta,
  options: UploadOptions = {},
): Promise<UploadResult> {
  return send('/api/admin/media/upload', file, meta, options);
}

/** POST /api/admin/media/<id>/replace: a new file for the same picture. */
export function replaceImage(
  id: string,
  file: Blob,
  meta: ReplaceMeta,
  options: UploadOptions = {},
): Promise<UploadResult> {
  return send(`/api/admin/media/${encodeURIComponent(id)}/replace`, file, meta, options);
}
