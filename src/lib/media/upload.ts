import { MEDIA_LONG_EDGE_PX, MEDIA_OBJECT_MAX_BYTES, MEDIA_UPLOAD_MAX_BYTES } from '@schemas/media';
import { finish, sniffImage, PROBE_MAX_BYTES, type ImageRefusal, type ImageSniff } from './sniff';
import { readWebp, stripWebpMetadata } from './webp';

// The upload pipeline's steps that touch the file (Admin v2 U3). The routes put them in
// this order, each refusing before the next costs anything:
//
//   checkLength   Content-Length is required and at most 20 MB: decided from the header,
//                 before a byte of the body is read (411, 413).
//   probeImage    the head of the body, through a clone of the request, until the sniffer
//                 has the size (src/lib/media/sniff.ts); the type and the decompression
//                 guard (415, 422). The rest of the body is never buffered by the Worker.
//   reencode      the body streamed into the Images binding: scaled down to a 2,560 px long
//                 edge, written as one WebP frame. Only this output is stored, so EXIF and
//                 GPS, a second frame or bytes appended after the image never reach the
//                 bucket. The output is read back: its own size, one frame, no metadata
//                 chunk (stripWebpMetadata drops any), no larger than the bucket allows.
//
// The image work runs in the Images service, not in the Worker, which is what fits it into
// the Workers Free plan's 10 ms of CPU: the Worker parses a header, reads chunk headers of
// the output, and copies bytes.

/** The part of the Images binding this uses (worker-configuration.d.ts `ImagesBinding`). */
export interface ImagesLike {
  input(stream: ReadableStream<Uint8Array>): {
    transform(transform: { width: number; height: number; fit: 'scale-down' }): {
      output(options: { format: 'image/webp'; quality: number; anim: boolean }): Promise<{
        image(): ReadableStream<Uint8Array>;
        contentType(): string;
      }>;
    };
  };
}

/** What an upload route answers instead of storing anything. */
export interface UploadRefusal {
  status: number;
  /** A stable code for the client (`unsupported-type`, `too-large`, …). */
  error: string;
  /** The sniffer's reason, when it was the sniffer. */
  reason?: ImageRefusal;
  /** Plain words for the editor. */
  detail: string;
}

export interface ReencodedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** WebP quality of the stored master; `/_image` derivatives are made from it. */
export const MASTER_QUALITY = 85;

export function isRefusal(value: unknown): value is UploadRefusal {
  return typeof value === 'object' && value !== null && 'status' in value && 'error' in value;
}

const REFUSALS: Record<ImageRefusal, UploadRefusal> = {
  empty: {
    status: 400,
    error: 'empty-file',
    detail: 'This file is empty. Please choose an image.',
  },
  svg: {
    status: 415,
    error: 'unsupported-type',
    detail: 'SVG files cannot be uploaded. Please save it as a JPEG, PNG or WebP image.',
  },
  gif: {
    status: 415,
    error: 'unsupported-type',
    detail: 'GIF files cannot be uploaded. Please use a JPEG, PNG or WebP image.',
  },
  heic: {
    status: 415,
    error: 'unsupported-type',
    detail: 'HEIC photos cannot be processed yet. Please export it as a JPEG first.',
  },
  avif: {
    status: 415,
    error: 'unsupported-type',
    detail: 'AVIF images cannot be processed here yet. Please export it as a JPEG, PNG or WebP.',
  },
  animated: {
    status: 415,
    error: 'unsupported-type',
    detail: 'Animated images cannot be uploaded. Please choose a still image.',
  },
  unknown_type: {
    status: 415,
    error: 'unsupported-type',
    detail: 'This file is not an image we can use. Please upload a JPEG, PNG or WebP image.',
  },
  structure: {
    status: 422,
    error: 'invalid-image',
    detail: 'This image looks damaged. Please export it again and retry.',
  },
  truncated: {
    status: 422,
    error: 'invalid-image',
    detail: 'This image is incomplete. Please export it again and retry.',
  },
  too_complex: {
    status: 422,
    error: 'invalid-image',
    detail: 'We could not read the size of this image. Please export it again and retry.',
  },
  dimensions: {
    status: 422,
    error: 'image-too-large',
    detail:
      'This image is too big to process: at most 12,000 pixels on a side and 40 megapixels. Please resize it and try again.',
  },
};

export function refusalFor(reason: ImageRefusal): UploadRefusal {
  return { ...REFUSALS[reason], reason };
}

export const NOT_SET_UP: UploadRefusal = {
  status: 503,
  error: 'not-set-up',
  detail: 'Uploads are not set up yet.',
};

/** The body's size from Content-Length, or why the upload stops before reading it. */
export function checkLength(request: Request): number | UploadRefusal {
  const header = request.headers.get('content-length');
  if (header === null) {
    return {
      status: 411,
      error: 'length-required',
      detail: 'We need to know the file size before it uploads. Please try again.',
    };
  }
  if (!/^\d{1,12}$/.test(header.trim())) {
    return { status: 400, error: 'bad-length', detail: 'The file size could not be read.' };
  }
  const length = Number(header.trim());
  if (length === 0) return refusalFor('empty');
  if (length > MEDIA_UPLOAD_MAX_BYTES) {
    return {
      status: 413,
      error: 'too-large',
      detail: 'This file is larger than 20 MB. Please choose a smaller image.',
    };
  }
  return length;
}

/**
 * Reads the head of the body through a CLONE of the request (a tee: the original keeps
 * every byte for the Images binding) until the sniffer can decide, then cancels the clone.
 */
export async function probeImage(request: Request, length: number): Promise<ImageSniff> {
  const body = request.clone().body;
  if (!body) return refusalOf('empty');
  const reader = body.getReader();
  // One buffer, each chunk copied in once: the probe never copies more than it reads.
  const head = new Uint8Array(Math.min(length, PROBE_MAX_BYTES));
  let read = 0;
  let verdict: ImageSniff | null = null;
  try {
    while (read < head.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, head.length - read);
      head.set(part, read);
      read += part.length;
      verdict = sniffImage(head.subarray(0, read), length);
      if (verdict) break;
    }
  } catch {
    return refusalOf('truncated');
  } finally {
    // Cancelled so the tee stops queueing the rest of the body for this branch, but NOT
    // awaited: a tee branch's cancel settles only once the other branch is cancelled or
    // read to the end too, which is the binding's job, later.
    void reader.cancel().catch(() => undefined);
  }
  return finish(verdict, read, length);
}

function refusalOf(reason: ImageRefusal): ImageSniff {
  return { ok: false, reason };
}

/** An Images binding failure: its code when it has one (9422 is the monthly quota). */
function bindingCode(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * Streams the body through the Images binding and checks what came back. The binding
 * applies EXIF rotation, scales down (never up) to the long edge, and keeps one frame.
 */
export async function reencode(
  images: ImagesLike,
  body: ReadableStream<Uint8Array>,
): Promise<ReencodedImage | UploadRefusal> {
  let bytes: Uint8Array;
  try {
    const result = await images
      .input(body)
      .transform({ width: MEDIA_LONG_EDGE_PX, height: MEDIA_LONG_EDGE_PX, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: MASTER_QUALITY, anim: false });
    if (result.contentType() !== 'image/webp') return processingFailed();
    bytes = new Uint8Array(await new Response(result.image()).arrayBuffer());
  } catch (err) {
    const code = bindingCode(err);
    if (code === 9422) {
      return {
        status: 503,
        error: 'images-quota',
        detail: 'Image processing has reached its monthly limit. Please try again later.',
      };
    }
    if (code === 9412) return refusalFor('unknown_type');
    return processingFailed();
  }

  const info = readWebp(bytes);
  if (!info || info.animated) return processingFailed();
  if (Math.max(info.width, info.height) > MEDIA_LONG_EDGE_PX) return processingFailed();
  const clean = info.metadata > 0 ? stripWebpMetadata(bytes) : bytes;
  if (clean.length > MEDIA_OBJECT_MAX_BYTES) {
    return {
      status: 413,
      error: 'too-large',
      detail: 'This image is still too large after compressing. Please choose a smaller image.',
    };
  }
  return { bytes: clean, width: info.width, height: info.height };
}

function processingFailed(): UploadRefusal {
  return {
    status: 502,
    error: 'processing-failed',
    detail: 'We could not process this image. Please try again.',
  };
}
