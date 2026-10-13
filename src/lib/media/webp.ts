// The re-encoded master an upload stores (Admin v2 U3): one WebP, read whole after the
// Images binding wrote it. Two jobs, both cheap (a walk over a handful of chunk headers):
//
//   readWebp           the stored row's width and height come from the OUTPUT, never from
//                      the upload's header (EXIF rotation and the long-edge cap change
//                      them), and an animated output is refused even though the binding was
//                      asked for one frame.
//   stripWebpMetadata  WebP output from Cloudflare Images carries no metadata ("all metadata
//                      will always be discarded" for WebP), and this makes that true by
//                      construction: an `EXIF` or `XMP ` chunk is dropped and its VP8X flag
//                      cleared, so GPS and camera data never reach the public bucket.

export interface WebpInfo {
  width: number;
  height: number;
  animated: boolean;
  /** `EXIF` and `XMP ` chunks present. */
  metadata: number;
}

interface Chunk {
  type: string;
  /** Offset of the chunk header. */
  start: number;
  /** Offset after its data and padding byte. */
  end: number;
}

const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

const u16le = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, o: number) =>
  (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, o: number) => (u24le(b, o) | ((b[o + 3] ?? 0) << 24)) >>> 0;

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i += 1) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

/** Every chunk of a complete WebP, or null when the container is not exactly one. */
function chunksOf(b: Uint8Array): Chunk[] | null {
  if (b.length < 20 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') return null;
  if (u32le(b, 4) + 8 !== b.length) return null;
  const chunks: Chunk[] = [];
  let p = 12;
  while (p < b.length) {
    if (p + 8 > b.length) return null;
    const length = u32le(b, p + 4);
    const end = p + 8 + length + (length & 1);
    if (end > b.length) return null;
    chunks.push({ type: ascii(b, p, p + 4), start: p, end });
    p = end;
  }
  return chunks;
}

/** The size and shape of a complete WebP, or null when it is not one. */
export function readWebp(b: Uint8Array): WebpInfo | null {
  const chunks = chunksOf(b);
  const first = chunks?.[0];
  if (!chunks || !first) return null;
  const data = first.start + 8;
  let width: number;
  let height: number;
  let animated = chunks.some((c) => c.type === 'ANIM' || c.type === 'ANMF');
  if (first.type === 'VP8X') {
    width = 1 + u24le(b, data + 4);
    height = 1 + u24le(b, data + 7);
    animated ||= ((b[data] ?? 0) & VP8X_ANIMATION) !== 0;
  } else if (first.type === 'VP8 ') {
    width = u16le(b, data + 6) & 0x3fff;
    height = u16le(b, data + 8) & 0x3fff;
  } else if (first.type === 'VP8L') {
    if (b[data] !== 0x2f) return null;
    const bits = u32le(b, data + 1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else {
    return null;
  }
  if (width === 0 || height === 0) return null;
  const metadata = chunks.filter((c) => c.type === 'EXIF' || c.type === 'XMP ').length;
  return { width, height, animated, metadata };
}

/**
 * The same image without its `EXIF` and `XMP ` chunks (and their VP8X flags). The input is
 * returned as it is when it has none, which is the expected case.
 */
export function stripWebpMetadata(b: Uint8Array): Uint8Array {
  const chunks = chunksOf(b);
  if (!chunks) return b;
  const kept = chunks.filter((c) => c.type !== 'EXIF' && c.type !== 'XMP ');
  if (kept.length === chunks.length) return b;
  const size = 12 + kept.reduce((n, c) => n + (c.end - c.start), 0);
  const out = new Uint8Array(size);
  out.set(b.subarray(0, 12), 0);
  let o = 12;
  for (const c of kept) {
    out.set(b.subarray(c.start, c.end), o);
    if (c.type === 'VP8X') out[o + 8] = (out[o + 8] ?? 0) & ~(VP8X_EXIF | VP8X_XMP);
    o += c.end - c.start;
  }
  const riff = size - 8;
  out[4] = riff & 0xff;
  out[5] = (riff >>> 8) & 0xff;
  out[6] = (riff >>> 16) & 0xff;
  out[7] = (riff >>> 24) & 0xff;
  return out;
}
