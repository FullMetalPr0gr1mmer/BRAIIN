import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { decodeMediaMeta, MEDIA_META_HEADER, MediaUploadMetaSchema } from '@schemas/media';
import { checkLength, refusalFor } from '@/lib/media/upload';
import {
  fileFacts,
  TOO_LARGE_TEXT,
  UNREADABLE_TEXT,
  type Decode,
} from '@/components/admin/fields/media/fileFacts';
import {
  altProblem,
  nextToSend,
  queueReducer,
  queueSummary,
  type UploadItem,
} from '@/components/admin/fields/media/uploadQueue';
import {
  displayNameOf,
  replaceImage,
  uploadImage,
  UploadAborted,
} from '@/components/admin/fields/media/xhrUpload';
import {
  CONFLICT_TEXT,
  LIMIT_TEXT,
  NETWORK_TEXT,
  refusalText,
  ROLE_TEXT,
} from '@/components/admin/fields/media/refusalText';
import { gridMove } from '@/components/admin/fields/media/MediaGrid';
import {
  altGap,
  caption,
  dimsText,
  sizeText,
  typeText,
} from '@/components/admin/fields/media/format';
import { tileName } from '@/components/admin/fields/media/MediaTile';

// The browser half of an upload (Admin v2 U4), in node: what the dialog says about a file
// before it is sent (fileFacts: the server's own sniffer and words), the dialog's queue
// (one file at a time, Cancel, Try again), the XHR that sends it (U3's raw body and header
// contract), the words for a refusal, the grid's arrow keys, and how a picture is named.

const jpeg = async (w = 64, h = 48) =>
  new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background: '#2050a0' } })
      .jpeg()
      .toBuffer(),
  );
const blob = (...parts: (Uint8Array | string)[]) => new Blob(parts as BlobPart[]);
const decodes =
  (width: number, height: number, closed: string[] = []): Decode =>
  async () => ({ width, height, close: () => closed.push('closed') });

describe('fileFacts: what the dialog knows before a byte is sent', () => {
  it('a JPEG: its decoded size, and the bitmap closed', async () => {
    const closed: string[] = [];
    const facts = await fileFacts(blob(await jpeg()), decodes(48, 64, closed));
    expect(facts).toEqual({ ok: true, format: 'jpeg', width: 48, height: 64 });
    expect(closed).toEqual(['closed']);
  });

  it('20 MB is the limit: 20,000,000 bytes pass, 20,000,001 are refused in the route’s words', async () => {
    const head = await jpeg();
    const at = blob(head, new Uint8Array(20_000_000 - head.length));
    expect(at.size).toBe(20_000_000);
    expect((await fileFacts(at, decodes(1, 1))).ok).toBe(true);
    const over = blob(head, new Uint8Array(20_000_001 - head.length));
    expect(await fileFacts(over, decodes(1, 1))).toEqual({ ok: false, detail: TOO_LARGE_TEXT });
    // The same words checkLength answers with (413).
    const refusal = checkLength(
      new Request('https://x.test', { method: 'POST', headers: { 'content-length': '20000001' } }),
    );
    expect(refusal).toMatchObject({ status: 413, detail: TOO_LARGE_TEXT });
  });

  it('refuses by the bytes, never the name: a renamed SVG, a GIF, a HEIC', async () => {
    const decode = vi.fn(decodes(10, 10));
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'photo.jpg', {
      type: 'image/jpeg',
    });
    expect(await fileFacts(svg, decode)).toEqual({ ok: false, detail: refusalFor('svg').detail });
    const gif = new File(['GIF89a', new Uint8Array(32)], 'a.png', { type: 'image/png' });
    expect(await fileFacts(gif, decode)).toEqual({ ok: false, detail: refusalFor('gif').detail });
    const heic = new File(
      [new Uint8Array([0, 0, 0, 24]), 'ftypheic', new Uint8Array(32)],
      'IMG_0001.jpg',
    );
    expect(await fileFacts(heic, decode)).toEqual({
      ok: false,
      detail: refusalFor('heic').detail,
    });
    // A refused file is never decoded.
    expect(decode).not.toHaveBeenCalled();
  });

  it('an empty file, and one the browser cannot decode', async () => {
    expect(await fileFacts(blob(), decodes(1, 1))).toEqual({
      ok: false,
      detail: refusalFor('empty').detail,
    });
    const broken: Decode = async () => {
      throw new Error('InvalidStateError');
    };
    expect(await fileFacts(blob(await jpeg()), broken)).toEqual({
      ok: false,
      detail: UNREADABLE_TEXT,
    });
  });
});

describe('the upload queue', () => {
  const add = (n: number) =>
    queueReducer([], {
      type: 'add',
      files: Array.from({ length: n }, (_, i) => ({ key: i + 1, name: `p${i + 1}.jpg`, size: 10 })),
    });
  const ready = (items: UploadItem[]) =>
    items.reduce(
      (acc, item) =>
        queueReducer(acc, {
          type: 'checked',
          key: item.key,
          facts: { ok: true, format: 'jpeg', width: 4, height: 3 },
        }),
      items,
    );
  const describe2 = (items: UploadItem[], keys: number[]) =>
    keys.reduce(
      (acc, key) => queueReducer(acc, { type: 'edit', key, alt: { en: 'A dune', ar: 'كثيب' } }),
      items,
    );

  it('alt text is required in both languages, at most 300 characters, no control character', () => {
    expect(altProblem('')).toBe('is required');
    expect(altProblem('   ')).toBe('is required');
    expect(altProblem('a'.repeat(300))).toBeNull();
    expect(altProblem('a'.repeat(301))).toBe('is at most 300 characters');
    expect(altProblem('two\nlines')).toMatch(/control/);
    expect(altProblem('كثيب رملي')).toBeNull();
  });

  it('only checked, described files are queued, and they go one at a time in order', () => {
    let items = describe2(ready(add(3)), [1, 3]);
    items = queueReducer(items, { type: 'submit' });
    expect(items.map((i) => i.state)).toEqual(['queued', 'ready', 'queued']);
    expect(nextToSend(items)?.key).toBe(1);
    items = queueReducer(items, { type: 'sending', key: 1 });
    expect(nextToSend(items)).toBeNull(); // one in flight
    items = queueReducer(items, { type: 'progress', key: 1, fraction: 0.4 });
    items = queueReducer(items, { type: 'progress', key: 1, fraction: 0.2 }); // never backwards
    expect(items[0]?.progress).toBe(0.4);
    items = queueReducer(items, { type: 'done', key: 1, row: { id: 'm1' } });
    expect(nextToSend(items)?.key).toBe(3);
    expect(queueSummary(items)).toMatchObject({ done: 1, busy: true, sendable: 1 });
  });

  it('a file refused locally is never queued', () => {
    let items = queueReducer(add(1), {
      type: 'checked',
      key: 1,
      facts: { ok: false, detail: 'SVG files cannot be uploaded.' },
    });
    items = queueReducer(describe2(items, [1]), { type: 'submit' });
    expect(items[0]?.state).toBe('refused-locally');
    expect(nextToSend(items)).toBeNull();
  });

  it('Cancel stops the file in flight and leaves nothing pending', () => {
    let items = queueReducer(describe2(ready(add(2)), [1, 2]), { type: 'submit' });
    items = queueReducer(items, { type: 'sending', key: 1 });
    items = queueReducer(items, { type: 'progress', key: 1, fraction: 0.7 });
    items = queueReducer(items, { type: 'cancel' });
    expect(items.map((i) => [i.state, i.progress])).toEqual([
      ['ready', 0],
      ['ready', 0],
    ]);
    expect(queueSummary(items).busy).toBe(false);
    expect(nextToSend(items)).toBeNull();
  });

  it('Try again queues one refused or failed file, and only that one', () => {
    let items = queueReducer(describe2(ready(add(2)), [1, 2]), { type: 'submit' });
    items = queueReducer(items, { type: 'sending', key: 1 });
    items = queueReducer(items, { type: 'refused', key: 1, detail: 'Too thin.' });
    items = queueReducer(items, { type: 'sending', key: 2 });
    items = queueReducer(items, { type: 'failed', key: 2, detail: NETWORK_TEXT });
    expect(queueSummary(items)).toMatchObject({ problems: 2, busy: false });
    items = queueReducer(items, { type: 'retry', key: 2 });
    expect(items.map((i) => i.state)).toEqual(['refused', 'queued']);
    expect(nextToSend(items)?.key).toBe(2);
    // A file that is not refused or failed is not touched by Try again.
    expect(queueReducer(items, { type: 'retry', key: 2 })).toEqual(items);
  });

  it('a file being sent or sent can no longer be edited or removed', () => {
    let items = queueReducer(describe2(ready(add(1)), [1]), { type: 'submit' });
    items = queueReducer(items, { type: 'sending', key: 1 });
    expect(queueReducer(items, { type: 'edit', key: 1, alt: { en: 'x' } })[0]?.alt.en).toBe(
      'A dune',
    );
    expect(queueReducer(items, { type: 'remove', key: 1 })).toHaveLength(1);
  });
});

// A stand-in for XMLHttpRequest: records what is sent and lets the test answer.
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  responseType = '';
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, payload: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    this.onload?.();
  }
}

describe('xhrUpload: U3’s wire contract, with progress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeXhr.last = null;
  });
  const stub = () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    vi.stubGlobal('document', {
      querySelector: (sel: string) =>
        sel === 'meta[name="csrf-token"]' ? { getAttribute: () => 'tok-123' } : null,
    });
  };
  const META = {
    alt: { en: 'Sand at dusk', ar: 'رمال عند الغروب' },
    displayName: 'Desert dunes.jpg',
    tags: ['dunes'],
  };

  it('POSTs the file as the raw body with the CSRF token, its type and the details header', async () => {
    stub();
    const file = new File([await jpeg()], 'Desert dunes.jpg', { type: 'image/jpeg' });
    const progress: number[] = [];
    const sent = uploadImage(file, META, { onProgress: (f) => progress.push(f) });
    const xhr = FakeXhr.last!;
    expect([xhr.method, xhr.url, xhr.body]).toEqual(['POST', '/api/admin/media/upload', file]);
    expect(xhr.headers['x-csrf-token']).toBe('tok-123');
    expect(xhr.headers['content-type']).toBe('image/jpeg');
    const decoded = decodeMediaMeta(xhr.headers[MEDIA_META_HEADER] ?? null);
    expect(decoded).toEqual(META);
    expect(MediaUploadMetaSchema.safeParse(decoded).success).toBe(true);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 } as ProgressEvent);
    xhr.answer(200, { ok: true, data: { id: 'm1', thumb_url: '/_image?x' } });
    expect(await sent).toEqual({ ok: true, row: { id: 'm1', thumb_url: '/_image?x' } });
    expect(progress).toEqual([0.25, 1]);
  });

  it('a refusal comes back as {status, error, detail}', async () => {
    stub();
    const sent = uploadImage(blob('x'), META);
    FakeXhr.last!.answer(415, {
      ok: false,
      error: 'unsupported-type',
      detail: 'SVG files cannot be uploaded. Please save it as a JPEG, PNG or WebP image.',
    });
    expect(await sent).toEqual({
      ok: false,
      refusal: {
        status: 415,
        error: 'unsupported-type',
        detail: 'SVG files cannot be uploaded. Please save it as a JPEG, PNG or WebP image.',
      },
    });
  });

  it('a network error is status 0; an abort rejects with UploadAborted', async () => {
    stub();
    const lost = uploadImage(blob('x'), META);
    FakeXhr.last!.onerror?.();
    expect(await lost).toEqual({ ok: false, refusal: { status: 0, error: 'network' } });
    const controller = new AbortController();
    const cancelled = uploadImage(blob('x'), META, { signal: controller.signal });
    const xhr = FakeXhr.last!;
    controller.abort();
    expect(xhr.aborted).toBe(true);
    await expect(cancelled).rejects.toBeInstanceOf(UploadAborted);
  });

  it('a replace goes to its own address with the version and removePrevious', async () => {
    stub();
    const sent = replaceImage('a/b', blob('x'), { version: 3, removePrevious: true });
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe('/api/admin/media/a%2Fb/replace');
    expect(decodeMediaMeta(xhr.headers[MEDIA_META_HEADER] ?? null)).toEqual({
      version: 3,
      removePrevious: true,
    });
    xhr.answer(409, { ok: false, error: 'conflict' });
    expect(await sent).toMatchObject({ ok: false, refusal: { status: 409 } });
  });

  it('a file name is cleaned the way the schema reads one', () => {
    expect(displayNameOf('IMG_0001.jpg')).toBe('IMG_0001.jpg');
    expect(displayNameOf('a/b\\c.jpg')).toBe('a b c.jpg');
    expect(displayNameOf(`x${'\u0007'}y.png`)).toBe('x y.png');
    expect(displayNameOf('   ')).toBeUndefined();
    expect(Array.from(displayNameOf('é'.repeat(250))!)).toHaveLength(200);
  });
});

describe('refusalText', () => {
  it('shows the route’s own words for every U3 code', () => {
    for (const error of [
      'unsupported-type',
      'invalid-image',
      'image-too-large',
      'image-too-thin',
      'too-large',
      'length-required',
      'not-set-up',
    ]) {
      expect(refusalText({ status: 415, error, detail: `words for ${error}` }), error).toBe(
        `words for ${error}`,
      );
    }
  });

  it('the daily cap, a role, a lost race on replace, a dropped connection', () => {
    expect(refusalText({ status: 429, error: 'rate-limit' })).toBe(LIMIT_TEXT);
    expect(LIMIT_TEXT).toContain('50 pictures a day');
    expect(LIMIT_TEXT).not.toMatch(/hour/);
    expect(refusalText({ status: 403, error: 'forbidden' })).toBe(ROLE_TEXT);
    expect(refusalText({ status: 409, error: 'conflict' }, 'replace')).toBe(CONFLICT_TEXT);
    expect(refusalText({ status: 0, error: 'network' })).toBe(NETWORK_TEXT);
    expect(refusalText({ status: 500, error: 'server' })).toMatch(/system log/);
  });

  it('no dash the copy rules forbid (P-12)', () => {
    for (const text of [
      LIMIT_TEXT,
      ROLE_TEXT,
      CONFLICT_TEXT,
      NETWORK_TEXT,
      TOO_LARGE_TEXT,
      UNREADABLE_TEXT,
    ]) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('the grid’s keys (gridMove)', () => {
  it('arrows along a row and down a column, mirrored in RTL, never wrapping', () => {
    // 10 tiles, 4 to a row.
    expect(gridMove('ArrowRight', 0, 10, 4)).toBe(1);
    expect(gridMove('ArrowLeft', 0, 10, 4)).toBe(0);
    expect(gridMove('ArrowRight', 9, 10, 4)).toBe(9);
    expect(gridMove('ArrowRight', 1, 10, 4, true)).toBe(0);
    expect(gridMove('ArrowLeft', 1, 10, 4, true)).toBe(2);
    expect(gridMove('ArrowDown', 1, 10, 4)).toBe(5);
    expect(gridMove('ArrowDown', 7, 10, 4)).toBe(7); // no tile below
    expect(gridMove('ArrowUp', 5, 10, 4)).toBe(1);
    expect(gridMove('ArrowUp', 2, 10, 4)).toBe(2);
    expect(gridMove('Home', 7, 10, 4)).toBe(0);
    expect(gridMove('End', 0, 10, 4)).toBe(9);
    expect(gridMove('Enter', 0, 10, 4)).toBeNull();
    expect(gridMove('ArrowRight', 0, 0, 4)).toBeNull();
  });
});

describe('how a picture is named', () => {
  const upload = {
    id: 'u',
    provider: 'storage',
    kind: 'image',
    storage_path:
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/7e3f9c2a-1b4d-4e8f-9a6b-5c3d2e1f0a9b_2560x1707.webp',
    display_name: 'Desert dunes.jpg',
    alt: { en: 'Sand at dusk', ar: '' },
    width: 2560,
    height: 1707,
    size_bytes: 412_000,
  };

  it('the name it was uploaded with, else the English alt, else a still’s file name; never a key', () => {
    expect(caption(upload)).toBe('Desert dunes.jpg');
    expect(caption({ ...upload, display_name: null })).toBe('Sand at dusk');
    expect(caption({ ...upload, display_name: null, alt: null })).toBe('Untitled picture');
    expect(caption({ provider: 'static', storage_path: 'stills/work/p0.jpg', alt: {} })).toBe(
      'p0.jpg',
    );
  });

  it('sizes in KB of 1,000 bytes, dimensions in words, en-GB digits', () => {
    expect(sizeText(412_000)).toBe('412 KB');
    expect(sizeText(3_400_000)).toBe('3.4 MB');
    expect(sizeText(900)).toBe('900 B');
    expect(sizeText(null)).toBeNull();
    expect(dimsText(2560, 1707)).toBe('2,560 by 1,707');
    expect(dimsText(null, 4)).toBeNull();
    expect(typeText(upload)).toBe('WebP image');
    expect(typeText({ provider: 'static' })).toBe('Image shipped with the site');
  });

  it('a tile is named by its caption first (WCAG 2.5.3), then what it shows', () => {
    expect(tileName(upload)).toBe('Desert dunes.jpg, 2,560 by 1,707, 412 KB, No Arabic alt');
    expect(altGap({ alt: { en: 'A', ar: 'ب' } })).toBeNull();
  });
});
