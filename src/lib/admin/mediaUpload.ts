import { env } from 'cloudflare:workers';
import { decodeMediaMeta, MEDIA_META_HEADER } from '@schemas/media';
import type { AuthContext } from '@/lib/auth/types';
import { supabaseConfigured } from '@/lib/supabase/client';
import {
  checkLength,
  isRefusal,
  NOT_SET_UP,
  probeImage,
  reencode,
  refusalFor,
  type ImagesLike,
  type ReencodedImage,
  type UploadRefusal,
} from '@/lib/media/upload';
import type { ImageFormat } from '@/lib/media/sniff';
import { ValidationError } from './errors';
import { liveRecheck } from './liveRecheck';
import { claimPrivilegedOp, MEDIA_UPLOAD_LIMITS } from './rateLimit';
import { json } from './route';

// What the two routes that take an image share (POST /api/admin/media/upload and
// /api/admin/media/[id]/replace, Admin v2 U3). The kernel (defineAdminRoute) has already
// checked `media.write` at full level and the middleware the CSRF token (header-only for a
// raw body); from here, in order, each step refusing before the next costs anything:
//
//   Content-Length ≤ 20 MB → configured (the Images binding and Supabase, else "Not set up")
//   → live recheck (the service role writes the object, so a demoted editor is refused now,
//   not at their next sign-in) → the head sniffed → a slot under the daily upload limit →
//   the body streamed through the Images binding → the WebP master checked.
//
// The wire contract (the library's upload dialog, U4, sends it): the file is the request
// BODY, sent as it is (any Content-Type: the bytes decide), with `x-csrf-token` and the
// details in `x-media-meta` as `encodeMediaMeta({...})` (packages/schemas/media.ts). A
// raw body is what lets the Worker stream a 20 MB file to the binding instead of holding it.

/** The Images binding, when this Worker has one. */
export function imagesBinding(): ImagesLike | undefined {
  const images = (env as unknown as { IMAGES?: ImagesLike }).IMAGES;
  return images && typeof images.input === 'function' ? images : undefined;
}

/** An upload's details from its header, before Zod: missing or unreadable is a 422. */
export function readMediaMeta(request: Request): unknown {
  const meta = decodeMediaMeta(request.headers.get(MEDIA_META_HEADER));
  if (meta === undefined) {
    throw new ValidationError('the file details are missing or could not be read', 'meta');
  }
  return meta;
}

/** A refusal in the kernel's error envelope, with words for the editor. */
export function refusalResponse(refusal: UploadRefusal): Response {
  return json(
    {
      ok: false,
      error: refusal.error,
      detail: refusal.detail,
      ...(refusal.reason ? { reason: refusal.reason } : {}),
    },
    refusal.status,
  );
}

export const STORAGE_FAILED: UploadRefusal = {
  status: 502,
  error: 'storage-failed',
  detail: 'We could not save the image. Please try again.',
};

export interface AcceptedImage extends ReencodedImage {
  /** What was uploaded: its format, its header's size and its byte count. */
  input: { format: ImageFormat; width: number; height: number; bytes: number };
}

/**
 * The request's body as a stored-ready WebP master, or why not. Throws only what the kernel
 * maps: AuthorizationError (a live recheck that fails, 403) and RateLimitError (429).
 */
export async function acceptImage(
  request: Request,
  auth: AuthContext,
): Promise<AcceptedImage | UploadRefusal> {
  const length = checkLength(request);
  if (isRefusal(length)) return length;

  const images = imagesBinding();
  if (!images || !supabaseConfigured()) return NOT_SET_UP;

  await liveRecheck(auth);

  // From here the body has been opened (the probe tees it). Whatever stops the upload before
  // the binding takes the body also cancels it, so the runtime is not left holding a file
  // nothing will read.
  let handedOff = false;
  try {
    const sniff = await probeImage(request, length);
    if (!sniff.ok) return refusalFor(sniff.reason);

    // After the sniff, so a refused file costs no slot; before the binding, which is what
    // the limit protects (the Images quota).
    await claimPrivilegedOp(auth, 'media-upload', MEDIA_UPLOAD_LIMITS);

    if (!request.body) return refusalFor('empty');
    handedOff = true;
    const master = await reencode(images, request.body);
    if (isRefusal(master)) return master;
    return {
      ...master,
      input: { format: sniff.format, width: sniff.width, height: sniff.height, bytes: length },
    };
  } finally {
    if (!handedOff) void request.body?.cancel().catch(() => undefined);
  }
}
