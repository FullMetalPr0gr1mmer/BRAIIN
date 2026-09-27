import { describe, it, expect } from 'vitest';
import { contentRange, ifRangeAllows, parseRange, sliceStream } from '@/lib/http/range';

// RFC 9110 §14 byte ranges for /media/*.mp4 (EXC-009). Without them a <video> reports
// seekable = [0, 0] and every clip window plays the showreel from 0 — the production
// defect of 2026-09-27. These are the edges a media element, a crawler or a hostile client
// can actually send.

const SIZE = 1000;

describe('parseRange', () => {
  it('no header (or an empty one without "=") → the whole file', () => {
    expect(parseRange(null, SIZE)).toEqual({ kind: 'full' });
    expect(parseRange(undefined, SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('', SIZE)).toEqual({ kind: 'full' });
  });

  it('bytes=a-b → that window, inclusive', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseRange('bytes=500-500', SIZE)).toEqual({ kind: 'partial', start: 500, end: 500 });
  });

  it('bytes=a- → from a to the last byte (what a <video> sends first: bytes=0-)', () => {
    expect(parseRange('bytes=0-', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(parseRange('bytes=990-', SIZE)).toEqual({ kind: 'partial', start: 990, end: 999 });
  });

  it('bytes=-n → the final n bytes, clamped to the whole file', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(parseRange('bytes=900-99999', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('tolerates whitespace and a case-insensitive unit', () => {
    expect(parseRange('Bytes = 10 - 20', SIZE)).toEqual({ kind: 'partial', start: 10, end: 20 });
  });

  it('ignores an unknown unit (MUST, §14.2) → 200', () => {
    expect(parseRange('items=0-5', SIZE)).toEqual({ kind: 'full' });
  });

  it('answers a multi-range request with the whole file, never multipart', () => {
    expect(parseRange('bytes=0-1,5-9', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1, -5', SIZE)).toEqual({ kind: 'full' });
  });

  it.each([
    ['bytes=1000-', 'start at the size'],
    ['bytes=5000-6000', 'start past the end'],
    ['bytes=-0', 'zero-length suffix'],
    ['bytes=5-2', 'last < first'],
    ['bytes=abc', 'no dash'],
    ['bytes=', 'empty spec'],
    ['bytes=-', 'neither position'],
    ['bytes=a-5', 'non-numeric first'],
    ['bytes=5-b', 'non-numeric last'],
    ['bytes=-x', 'non-numeric suffix'],
    ['bytes=+5-9', 'signed first'],
    ['bytes=1e3-', 'exponent'],
    ['bytes=0x10-', 'hex'],
  ])('%s (%s) → 416', (header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('every range of an empty file is unsatisfiable; no header is still a 200', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange(null, 0)).toEqual({ kind: 'full' });
  });

  it('a one-byte file answers bytes=0-0 and bytes=-1', () => {
    expect(parseRange('bytes=0-0', 1)).toEqual({ kind: 'partial', start: 0, end: 0 });
    expect(parseRange('bytes=-1', 1)).toEqual({ kind: 'partial', start: 0, end: 0 });
  });

  it('handles the real showreel size (12,233,105 bytes)', () => {
    const size = 12_233_105;
    expect(parseRange('bytes=12233000-', size)).toEqual({
      kind: 'partial',
      start: 12_233_000,
      end: size - 1,
    });
  });
});

describe('contentRange', () => {
  it('206 form and 416 form', () => {
    expect(contentRange(1000, { start: 0, end: 99 })).toBe('bytes 0-99/1000');
    expect(contentRange(1000)).toBe('bytes */1000');
    expect(contentRange(0)).toBe('bytes */0');
  });
});

describe('ifRangeAllows', () => {
  const v = { etag: '"abc"', lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT' };

  it('no If-Range → the range applies', () => {
    expect(ifRangeAllows(null, v)).toBe(true);
    expect(ifRangeAllows(undefined, v)).toBe(true);
  });

  it('a matching strong ETag → the range applies; a mismatch → the whole file', () => {
    expect(ifRangeAllows('"abc"', v)).toBe(true);
    expect(ifRangeAllows('"other"', v)).toBe(false);
  });

  it('weak validators never admit a range (strong comparison only)', () => {
    expect(ifRangeAllows('W/"abc"', v)).toBe(false);
    expect(ifRangeAllows('"abc"', { etag: 'W/"abc"' })).toBe(false);
  });

  it('an ETag we do not have → the whole file', () => {
    expect(ifRangeAllows('"abc"', {})).toBe(false);
    expect(ifRangeAllows('"abc"', { etag: null })).toBe(false);
  });

  it('an HTTP-date equal to Last-Modified → the range applies; any other → the whole file', () => {
    expect(ifRangeAllows('Wed, 21 Oct 2025 07:28:00 GMT', v)).toBe(true);
    expect(ifRangeAllows('Thu, 22 Oct 2025 07:28:00 GMT', v)).toBe(false);
    expect(ifRangeAllows('not a date', v)).toBe(false);
    expect(ifRangeAllows('Wed, 21 Oct 2025 07:28:00 GMT', { etag: '"abc"' })).toBe(false);
  });
});

/** A source that yields `bytes` in the given chunk sizes and records whether it was cancelled. */
function chunked(bytes: Uint8Array, sizes: number[]) {
  const state = { cancelled: false, pulled: 0 };
  let offset = 0;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const n = sizes[i % sizes.length] ?? 1;
      i += 1;
      controller.enqueue(bytes.slice(offset, offset + n));
      offset += n;
      state.pulled = offset;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
}

const DATA = Uint8Array.from({ length: 100 }, (_, i) => i);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('sliceStream', () => {
  it.each([
    [0, 99, [100]],
    [0, 0, [7]],
    [10, 19, [7]],
    [95, 99, [7]],
    [33, 66, [1]],
    [40, 59, [3, 50, 1]],
    [50, 50, [10]],
  ])('bytes %i-%i across chunks of %j', async (start, end, sizes) => {
    const { stream } = chunked(DATA, sizes);
    expect(await collect(sliceStream(stream, start, end))).toEqual(range(start, end));
  });

  it('cancels the source once the window is complete (no read to the end of the file)', async () => {
    const { stream, state } = chunked(DATA, [10]);
    expect(await collect(sliceStream(stream, 0, 14))).toEqual(range(0, 14));
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(100);
  });

  it('a source shorter than the window just ends (never hangs)', async () => {
    const { stream } = chunked(DATA, [30]);
    expect(await collect(sliceStream(stream, 90, 200))).toEqual(range(90, 99));
  });

  it('cancelling the slice cancels the source', async () => {
    const { stream, state } = chunked(DATA, [10]);
    await sliceStream(stream, 0, 99).cancel('client went away');
    expect(state.cancelled).toBe(true);
  });
});
