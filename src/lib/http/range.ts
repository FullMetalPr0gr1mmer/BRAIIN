// HTTP byte ranges (RFC 9110 §14) — the pure half of the `/media/*.mp4` route
// (src/lib/http/media.ts). Pure on purpose: every edge of the spec is a unit test here, and
// the Worker glue stays small enough to read.
//
// Why this exists at all: Workers Static Assets ignores `Range` (measured on production
// 2026-09-27 — `Range: bytes=0-99` came back 200 with all 12,233,105 bytes and no
// `Accept-Ranges`). A <video> fed by such a server reports `seekable` = [0, 0], so every
// clip window (clips.ts `seekTarget`) was silently dropped and each surface played the
// showreel from 0 — and downloaded all of it (EXC-009).
//
// Scope is deliberately one range. A multi-range request (`bytes=0-1,5-9`) is answered 200
// with the whole file — RFC 9110 lets a server ignore Range, media elements never send
// multi-range, and multipart/byteranges is attack surface nothing here needs.

/** What to send for one resource of `size` bytes. `end` is INCLUSIVE, as on the wire. */
export type RangeDecision =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

const FULL: RangeDecision = { kind: 'full' };
const UNSATISFIABLE: RangeDecision = { kind: 'unsatisfiable' };

/** Positions are decimal digits only — no sign, no exponent, no whitespace inside. */
const POS = /^\d+$/;

/**
 * Decide how to answer `Range: <header>` for a resource of `size` bytes.
 *
 * - absent, or a unit other than `bytes`, or several ranges → `full` (200). An unknown
 *   unit MUST be ignored (§14.2).
 * - `bytes=a-b`, `bytes=a-`, `bytes=-n` → `partial`, with `b` clamped to the last byte.
 * - a malformed spec (`bytes=x`, `bytes=5-2`, `bytes=-`), a start at or past the end, a
 *   zero-length suffix (`bytes=-0`), or any range of an empty resource → `unsatisfiable`
 *   (416).
 */
export function parseRange(header: string | null | undefined, size: number): RangeDecision {
  if (header === null || header === undefined) return FULL;
  const eq = header.indexOf('=');
  if (eq < 0) return FULL;
  if (header.slice(0, eq).trim().toLowerCase() !== 'bytes') return FULL;

  const specs = header.slice(eq + 1).split(',');
  if (specs.length !== 1) return FULL;
  const spec = (specs[0] ?? '').trim();

  const dash = spec.indexOf('-');
  if (dash < 0) return UNSATISFIABLE;
  const first = spec.slice(0, dash).trim();
  const last = spec.slice(dash + 1).trim();

  if (first === '') {
    // suffix range: the final `n` bytes
    if (!POS.test(last)) return UNSATISFIABLE;
    const n = Number(last);
    if (n === 0 || size === 0) return UNSATISFIABLE;
    return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 };
  }

  if (!POS.test(first) || (last !== '' && !POS.test(last))) return UNSATISFIABLE;
  const start = Number(first);
  if (last !== '' && Number(last) < start) return UNSATISFIABLE;
  if (start >= size) return UNSATISFIABLE;
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return { kind: 'partial', start, end };
}

/** `Content-Range` for a 206 (`bytes a-b/size`) or a 416 (`bytes *\/size`). */
export function contentRange(size: number, range?: { start: number; end: number }): string {
  return range ? `bytes ${range.start}-${range.end}/${size}` : `bytes */${size}`;
}

/**
 * Whether `If-Range` lets the range through (RFC 9110 §13.1.5). A range is only honoured
 * against the SAME representation the client already holds part of: a strong ETag that
 * matches exactly, or an HTTP-date equal to `Last-Modified`. Anything else — a weak tag, a
 * mismatch, a validator we don't have — sends the whole file, which is always correct.
 */
export function ifRangeAllows(
  ifRange: string | null | undefined,
  validators: { etag?: string | null; lastModified?: string | null },
): boolean {
  if (ifRange === null || ifRange === undefined) return true;
  const value = ifRange.trim();
  if (value.startsWith('W/')) return false;
  if (value.startsWith('"')) {
    const etag = validators.etag ?? null;
    return etag !== null && !etag.startsWith('W/') && etag === value;
  }
  const lastModified = validators.lastModified ?? null;
  if (lastModified === null) return false;
  const a = Date.parse(value);
  const b = Date.parse(lastModified);
  return Number.isFinite(a) && a === b;
}

/**
 * Bytes `start..end` (inclusive) of a stream, without buffering it. The source is read from
 * the top — an asset body cannot be opened mid-file — but only the window is forwarded, and
 * the source is cancelled as soon as the window is complete, so a range near the start of a
 * 12 MB file stops reading after that range.
 */
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let offset = 0; // position of the next unread source byte
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (offset > end) {
          controller.close();
          await reader.cancel().catch(() => undefined);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunkStart = offset;
        offset += value.byteLength;
        if (offset <= start) continue; // entirely before the window
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, end + 1 - chunkStart);
        controller.enqueue(value.subarray(from, to));
        return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
