import { MEDIA_MAX_INPUT_PIXELS, MEDIA_MAX_INPUT_SIDE_PX, withinMediaAspect } from '@schemas/media';

// What an uploaded file must be before anything processes it (Admin v2 U3, A5): a still
// JPEG, PNG or WebP, decided by its own bytes. The browser's Content-Type and the file name
// are never read: a renamed SVG is still an SVG.
//
// Built for the Workers FREE plan (10 ms CPU per request): it reads only the file's HEAD,
// as far as the header that states the image's size, so its cost does not grow with the
// file. The size it finds is the decompression guard (≤ 12,000 px a side, ≤ 40 MP), checked
// before the Images binding decodes a pixel, and the proportions an image the site can show
// must have (neither side over 100 times the other, MEDIA_MAX_ASPECT).
//
// Refused, by what the bytes are:
//   • SVG and anything else that is markup (it is a document, not a picture);
//   • GIF, and animated PNG or WebP (owner decision A5: stills only);
//   • HEIC (the browser cannot show it) and AVIF (the Images binding reads AVIF only on an
//     Enterprise plan, so it could never be processed here);
//   • a header that is malformed, cut short, or not where the format puts it.
// What it does NOT do is read the rest of the file: bytes after the image (a polyglot's
// payload) never reach storage, because only the Images binding's re-encoded output is
// stored (src/lib/media/upload.ts).

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export type ImageRefusal =
  | 'empty'
  | 'svg'
  | 'gif'
  | 'heic'
  | 'avif'
  | 'animated'
  | 'unknown_type'
  | 'structure'
  | 'truncated'
  | 'too_complex'
  | 'dimensions'
  | 'aspect';

export type ImageSniff =
  | { ok: true; format: ImageFormat; width: number; height: number }
  | { ok: false; reason: ImageRefusal };

/** How much of the head a probe reads at most before it gives up on finding the size. */
export const PROBE_MAX_BYTES = 1_048_576;

/** A parser that needs more of the file than it has been given says so with this. */
const MORE = Symbol('need more bytes');
type Parsed = { width: number; height: number; animated: boolean } | ImageRefusal | typeof MORE;

const u16be = (b: Uint8Array, o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
const u32be = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number) =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, o: number) => (u24le(b, o) | ((b[o + 3] ?? 0) << 24)) >>> 0;

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < b.length; i += 1) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

function startsWith(b: Uint8Array, magic: readonly number[], at = 0): boolean {
  return magic.every((m, i) => b[at + i] === m);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Sniffs the head of a file `size` bytes long. Returns null while the head is too short to
 * decide, so a probe can read one more chunk and ask again; `finish()` turns a final null
 * into the refusal it means.
 */
export function sniffImage(head: Uint8Array, size: number): ImageSniff | null {
  if (size === 0 || head.length === 0) return { ok: false, reason: 'empty' };
  if (head.length < Math.min(size, 16)) return null;

  let format: ImageFormat;
  let parsed: Parsed;
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    format = 'jpeg';
    parsed = jpeg(head);
  } else if (startsWith(head, PNG_MAGIC)) {
    format = 'png';
    parsed = png(head);
  } else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    format = 'webp';
    parsed = webp(head, size);
  } else {
    return { ok: false, reason: notAnImage(head) };
  }

  if (parsed === MORE) return null;
  if (typeof parsed === 'string') return { ok: false, reason: parsed };
  if (parsed.animated) return { ok: false, reason: 'animated' };
  const { width, height } = parsed;
  if (
    width > MEDIA_MAX_INPUT_SIDE_PX ||
    height > MEDIA_MAX_INPUT_SIDE_PX ||
    width * height > MEDIA_MAX_INPUT_PIXELS
  ) {
    return { ok: false, reason: 'dimensions' };
  }
  if (!withinMediaAspect(width, height)) return { ok: false, reason: 'aspect' };
  return { ok: true, format, width, height };
}

/**
 * The verdict once a probe stops reading: the file ended before its header did
 * (`truncated`), or the header lies further in than a probe reads (`too_complex`).
 */
export function finish(result: ImageSniff | null, read: number, size: number): ImageSniff {
  if (result) return result;
  return { ok: false, reason: read >= size ? 'truncated' : 'too_complex' };
}

/** What a file that is none of the three formats is, for the refusal's wording. */
function notAnImage(b: Uint8Array): ImageRefusal {
  const sig = ascii(b, 0, 6);
  if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  if (ascii(b, 4, 8) === 'ftyp') return isoBrand(b);
  // Markup: an optional byte-order mark and whitespace, then `<` (`<svg`, `<?xml`, `<!--`,
  // `<html`). Whatever the document is, it is not a still image.
  let i = 0;
  if (startsWith(b, [0xef, 0xbb, 0xbf])) i = 3;
  else if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return 'svg';
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) {
    i += 1;
  }
  if (b[i] === 0x3c) return 'svg';
  return 'unknown_type';
}

const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

/** An ISO-BMFF file: AVIF, HEIC, or something else (a video, say) by its brands. */
function isoBrand(b: Uint8Array): ImageRefusal {
  const boxSize = u32be(b, 0);
  const end = Math.min(b.length, boxSize >= 16 ? boxSize : 16);
  const brands = [ascii(b, 8, 12)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(b, o, o + 4));
  // AVIF first: an AVIF lists `mif1` among its compatible brands too.
  if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
  if (brands.some((x) => HEIC_BRANDS.has(x))) return 'heic';
  return 'unknown_type';
}

// ── JPEG ────────────────────────────────────────────────────────────────────────────

/** Walks the marker segments from SOI to the first frame header (SOF). */
function jpeg(b: Uint8Array): Parsed {
  let p = 2;
  for (;;) {
    if (p >= b.length) return MORE;
    if (b[p] !== 0xff) return 'structure';
    while (p < b.length && b[p] === 0xff) p += 1; // fill bytes
    if (p >= b.length) return MORE;
    const marker = b[p] ?? 0;
    p += 1;
    // A second SOI, an EOI or the scan data before any frame header is not a JPEG.
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) {
      return 'structure';
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (p + 2 > b.length) return MORE;
    const length = u16be(b, p);
    if (length < 2) return 'structure';
    // Baseline, extended and progressive frames. Lossless and arithmetic-coded JPEGs
    // (SOF3, SOF5–7, SOF9–15) are refused: browsers do not show them either.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return 'structure';
      if (p + 7 > b.length) return MORE;
      const height = u16be(b, p + 3);
      const width = u16be(b, p + 5);
      // A height of 0 defers it to a DNL marker after the scan: not something to accept.
      if (width === 0 || height === 0) return 'structure';
      return { width, height, animated: false };
    }
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return 'unknown_type';
    }
    p += length;
  }
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(b: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = (CRC_TABLE[(c ^ (b[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The signature, then IHDR as the first chunk with a correct checksum, then every chunk up
 * to the first IDAT: an `acTL` there makes it an animated PNG.
 */
function png(b: Uint8Array): Parsed {
  if (b.length < 33) return MORE;
  if (u32be(b, 8) !== 13 || ascii(b, 12, 16) !== 'IHDR') return 'structure';
  if (crc32(b, 12, 29) !== u32be(b, 29)) return 'structure';
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    return 'structure';
  }
  let p = 33;
  while (p + 8 <= b.length) {
    const length = u32be(b, p);
    const type = ascii(b, p + 4, p + 8);
    if (type === 'acTL') return { width, height, animated: true };
    if (type === 'IDAT' || type === 'IEND') break;
    if (length > 0x7fffffff) return 'structure';
    p += 12 + length;
  }
  // An acTL beyond the head would come before an IDAT beyond it; the re-encode keeps one
  // frame whatever the input (src/lib/media/upload.ts), so a still is all that is stored.
  return { width, height, animated: false };
}

// ── WebP ────────────────────────────────────────────────────────────────────────────

/**
 * The RIFF header and the first chunk: `VP8 ` (lossy), `VP8L` (lossless) or `VP8X`
 * (extended, whose flags say whether it is animated). A RIFF longer than the file is a
 * file cut short.
 */
function webp(b: Uint8Array, size: number): Parsed {
  if (b.length < 30) return b.length >= size ? 'truncated' : MORE;
  if (u32le(b, 4) + 8 > size) return 'truncated';
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8X') {
    const flags = b[20] ?? 0;
    const width = 1 + u24le(b, 24);
    const height = 1 + u24le(b, 27);
    return { width, height, animated: (flags & 0x02) !== 0 || hasAnimationChunk(b) };
  }
  if (chunk === 'VP8 ') {
    // A key frame (bit 0 of the frame tag clear) with its start code, then 14-bit sizes.
    if (((b[20] ?? 0) & 0x01) !== 0 || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return 'structure';
    const width = u16le(b, 26) & 0x3fff;
    const height = u16le(b, 28) & 0x3fff;
    if (width === 0 || height === 0) return 'structure';
    return { width, height, animated: false };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return 'structure';
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, animated: false };
  }
  return 'structure';
}

/** An `ANIM` or `ANMF` chunk anywhere in the head: animated whatever the flags claim. */
function hasAnimationChunk(b: Uint8Array): boolean {
  let p = 12;
  while (p + 8 <= b.length) {
    const type = ascii(b, p, p + 4);
    if (type === 'ANIM' || type === 'ANMF') return true;
    const length = u32le(b, p + 4);
    p += 8 + length + (length & 1);
  }
  return false;
}
