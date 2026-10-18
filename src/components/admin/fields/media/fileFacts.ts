import { MEDIA_UPLOAD_MAX_BYTES } from '@schemas/media';
import { finish, PROBE_MAX_BYTES, sniffImage, type ImageFormat } from '@/lib/media/sniff';
import { refusalFor } from '@/lib/media/upload';

// What the browser can tell about a chosen file before a byte is sent (Admin v2 U4), so the
// upload dialog can say at once that a file will be refused, in the words the server would
// use. The SERVER stays the authority (it sniffs and re-encodes again); this is feedback.
//
//   1. its size: at most 20 MB (MEDIA_UPLOAD_MAX_BYTES), the route's own limit;
//   2. its bytes: U3's sniffer over the file's head (a renamed SVG, a GIF, a HEIC or an AVIF
//      is refused by what it is, never by its name), with the same decompression guard;
//   3. that it decodes, and at what size once its orientation is applied:
//      createImageBitmap(file), closed straight away. No URL is ever made of the file:
//      img-src has no blob: or data: (CSP), so there is no local preview.

export type FileFacts =
  { ok: true; format: ImageFormat; width: number; height: number } | { ok: false; detail: string };

export const TOO_LARGE_TEXT = 'This file is larger than 20 MB. Please choose a smaller image.';
export const UNREADABLE_TEXT =
  'We could not read this picture. Please export it as a JPEG, PNG or WebP and try again.';

/** The decoder: the browser's createImageBitmap, or a stand-in in tests. */
export type Decode = (file: Blob) => Promise<{ width: number; height: number; close(): void }>;

const browserDecode: Decode = (file) => createImageBitmap(file);

export async function fileFacts(file: Blob, decode: Decode = browserDecode): Promise<FileFacts> {
  if (file.size > MEDIA_UPLOAD_MAX_BYTES) return { ok: false, detail: TOO_LARGE_TEXT };
  if (file.size === 0) return { ok: false, detail: refusalFor('empty').detail };

  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, PROBE_MAX_BYTES).arrayBuffer());
  } catch {
    return { ok: false, detail: UNREADABLE_TEXT };
  }
  const sniff = finish(sniffImage(head, file.size), head.length, file.size);
  if (!sniff.ok) return { ok: false, detail: refusalFor(sniff.reason).detail };

  try {
    const bitmap = await decode(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { ok: true, format: sniff.format, ...size };
  } catch {
    return { ok: false, detail: UNREADABLE_TEXT };
  }
}
