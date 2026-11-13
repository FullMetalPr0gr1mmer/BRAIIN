import type { CrmFileKind } from '@schemas/crmFiles';
import { sniffCv, type SniffRefusal } from '@/lib/applications/fileSniff';

// What a contact file must be before it is stored (Admin v2 C16): its BYTES decide, never the
// browser's type or the name's extension. A PDF and a Word .docx go through the Join CV check
// (src/lib/applications/fileSniff.ts: a PDF's head and tail; a .docx read the way Word reads
// one, refusing macros, ActiveX, embedded objects and links out of the file). An image is
// checked by its own header: PNG (the signature, then IHDR first), JPEG (SOI, then a marker),
// WebP (a RIFF whose declared size is the file's, holding WEBP and a VP8 chunk). Anything else
// is refused: no SVG (it can carry script), no legacy Office format, no archive.
//
// Bounded for the Workers free plan (10 ms CPU): every check reads the head and, for a PDF or a
// .docx, the tail and the package's small XML parts, never the whole file. What it cannot see
// (an exploit aimed at the reader that opens the file) is the residual risk C16 records: the
// file is not virus-scanned, it leaves only as an attachment under a sandbox CSP, and the card
// says so beside every download.

export type FileSniffRefusal = SniffRefusal | 'image_structure';
export type FileSniffResult =
  { ok: true; kind: CrmFileKind } | { ok: false; reason: FileSniffRefusal };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function head(file: Blob, n: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.slice(start, end));

const u32le = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;

/** Which kind a contact file is, by its bytes, or why it is refused. */
export async function sniffContactFile(file: Blob): Promise<FileSniffResult> {
  if (file.size === 0) return { ok: false, reason: 'empty' };
  const h = await head(file, 32);

  // PNG: the eight-byte signature, then the IHDR chunk (13 bytes of data) first.
  if (PNG.every((byte, i) => h[i] === byte)) {
    return u32be(h, 8) === 13 && ascii(h, 12, 16) === 'IHDR' && file.size >= 45
      ? { ok: true, kind: 'png' }
      : { ok: false, reason: 'image_structure' };
  }
  // JPEG: start of image, then another marker.
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) {
    return (h[3] ?? 0) >= 0xc0 && (h[3] ?? 0) !== 0xff
      ? { ok: true, kind: 'jpeg' }
      : { ok: false, reason: 'image_structure' };
  }
  // WebP: RIFF, its size the file's own (nothing hidden after it), WEBP, a VP8 chunk.
  if (ascii(h, 0, 4) === 'RIFF') {
    const declared = u32le(h, 4) + 8;
    const sized = declared === file.size || declared + 1 === file.size;
    return sized && ascii(h, 8, 12) === 'WEBP' && /^VP8[ LX]$/.test(ascii(h, 12, 16))
      ? { ok: true, kind: 'webp' }
      : { ok: false, reason: 'image_structure' };
  }
  // A PDF or a .docx: the Join check (anything else it refuses as unknown_type).
  const cv = await sniffCv(file);
  return cv.ok ? { ok: true, kind: cv.kind } : cv;
}

/** What a refusal means, in words for the person who chose the file (P-12). */
export function sniffRefusalWords(reason: FileSniffRefusal): string {
  switch (reason) {
    case 'empty':
      return 'This file is empty.';
    case 'unknown_type':
      return 'Add a PDF, a Word document (.docx) or a PNG, JPEG or WebP image.';
    case 'macro':
      return 'This document has macros. Save it as a plain .docx or a PDF, then add it.';
    case 'active_content':
    case 'external_relationship':
      return 'This document holds embedded objects or links out of the file. Save it as a PDF, then add it.';
    case 'encrypted':
      return 'This document is password protected. Remove the password, then add it.';
    case 'image_structure':
      return 'This image could not be read. Save it again as PNG or JPEG, then add it.';
    default:
      return 'This file could not be read. Save it again as a PDF, then add it.';
  }
}
