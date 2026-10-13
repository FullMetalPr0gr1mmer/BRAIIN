import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { finish, sniffImage, PROBE_MAX_BYTES } from '@/lib/media/sniff';
import { readWebp, stripWebpMetadata } from '@/lib/media/webp';

// Admin v2 U3: an upload is a still JPEG, PNG or WebP by its own bytes, its header's size
// passes the decompression guard, and the WebP master that is stored carries no metadata.
// Fixtures are made here (sharp, and a few headers by hand), never committed files.

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 20, b: 20 } } });

const bytes = (b: Buffer | Uint8Array) => new Uint8Array(b);
const sniff = (b: Uint8Array) => sniffImage(b, b.length);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function pngHeader(width: number, height: number, extra: Uint8Array[] = []): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', new Uint8Array(4)),
  ];
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ascii = (s: string) => new TextEncoder().encode(s);

describe('sniffImage: what is accepted, by its bytes', () => {
  it('a JPEG, its size from the frame header (EXIF before it is skipped)', async () => {
    const jpeg = bytes(
      await solid(640, 480)
        .jpeg()
        .withExif({ IFD0: { ImageDescription: 'taken somewhere', Copyright: 'x' } })
        .toBuffer(),
    );
    expect(sniff(jpeg)).toEqual({ ok: true, format: 'jpeg', width: 640, height: 480 });
  });

  it('a progressive JPEG', async () => {
    const jpeg = bytes(await solid(300, 200).jpeg({ progressive: true }).toBuffer());
    expect(sniff(jpeg)).toEqual({ ok: true, format: 'jpeg', width: 300, height: 200 });
  });

  it('a PNG', async () => {
    const png = bytes(await solid(120, 90).png().toBuffer());
    expect(sniff(png)).toEqual({ ok: true, format: 'png', width: 120, height: 90 });
  });

  it('a WebP in each of its three forms (lossy, lossless, extended with alpha)', async () => {
    const lossy = bytes(await solid(64, 48).webp().toBuffer());
    const lossless = bytes(await solid(64, 48).webp({ lossless: true }).toBuffer());
    const alpha = bytes(
      await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 4,
          background: { r: 1, g: 2, b: 3, alpha: 0.5 },
        },
      })
        .webp()
        .toBuffer(),
    );
    for (const webp of [lossy, lossless, alpha]) {
      expect(sniff(webp)).toEqual({ ok: true, format: 'webp', width: 64, height: 48 });
    }
  });

  it('a polyglot passes the header check: its payload never reaches storage (re-encoded)', async () => {
    const jpeg = bytes(await solid(32, 32).jpeg().toBuffer());
    const polyglot = concat([jpeg, ascii('<html><script>alert(1)</script></html>')]);
    expect(sniff(polyglot)).toMatchObject({ ok: true, format: 'jpeg' });
  });
});

describe('sniffImage: what is refused', () => {
  it('SVG, however it is dressed (renamed, an XML prolog, a byte-order mark, leading space)', () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      '﻿<svg/>',
      '  \n<!DOCTYPE svg><svg/>',
      '<html><body>not an image</body></html>',
    ]) {
      expect(sniff(ascii(text))).toEqual({ ok: false, reason: 'svg' });
    }
  });

  it('GIF, still or animated', async () => {
    const still = bytes(await solid(10, 10).gif().toBuffer());
    expect(sniff(still)).toEqual({ ok: false, reason: 'gif' });
  });

  it('an animated WebP (by its flag) and an animated PNG (acTL before the image data)', async () => {
    const a = await solid(20, 20).png().toBuffer();
    const b = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();
    const animated = bytes(
      await sharp([a, b], { join: { animated: true } })
        .webp()
        .toBuffer(),
    );
    expect(sniff(animated)).toEqual({ ok: false, reason: 'animated' });

    const actl = pngChunk('acTL', new Uint8Array([0, 0, 0, 2, 0, 0, 0, 0]));
    expect(sniff(pngHeader(20, 20, [actl]))).toEqual({ ok: false, reason: 'animated' });
  });

  it('an animated WebP whose flag is cleared but which still has an ANIM chunk', () => {
    const vp8x = new Uint8Array(18);
    vp8x.set(ascii('VP8X'), 0);
    vp8x.set([10, 0, 0, 0], 4); // chunk size
    // flags 0, then canvas 20 x 20 (stored minus one)
    vp8x.set([19, 0, 0, 19, 0, 0], 12);
    const anim = new Uint8Array(14);
    anim.set(ascii('ANIM'), 0);
    anim.set([6, 0, 0, 0], 4);
    const body = concat([ascii('WEBP'), vp8x, anim]);
    const riff = concat([ascii('RIFF'), new Uint8Array([body.length, 0, 0, 0]), body]);
    expect(sniff(riff)).toEqual({ ok: false, reason: 'animated' });
  });

  it('HEIC and AVIF (the Images binding reads AVIF only on an Enterprise plan)', async () => {
    const avif = bytes(await solid(40, 30).avif().toBuffer());
    expect(sniff(avif)).toEqual({ ok: false, reason: 'avif' });

    const ftyp = concat([
      new Uint8Array([0, 0, 0, 24]),
      ascii('ftypheic'),
      new Uint8Array(4),
      ascii('mif1heic'),
    ]);
    expect(sniff(concat([ftyp, new Uint8Array(64)]))).toEqual({ ok: false, reason: 'heic' });
  });

  it('anything else (a bitmap, a PDF, an ISO video)', () => {
    expect(sniff(concat([ascii('BM'), new Uint8Array(64)]))).toEqual({
      ok: false,
      reason: 'unknown_type',
    });
    expect(sniff(ascii('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toEqual({ ok: false, reason: 'unknown_type' });
    const mp4 = concat([new Uint8Array([0, 0, 0, 20]), ascii('ftypisom'), new Uint8Array(40)]);
    expect(sniff(mp4)).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it('an empty file', () => {
    expect(sniffImage(new Uint8Array(0), 0)).toEqual({ ok: false, reason: 'empty' });
  });

  it('a header past the decompression guard (12,000 px a side, 40 megapixels)', () => {
    expect(sniff(pngHeader(12_001, 10))).toEqual({ ok: false, reason: 'dimensions' });
    expect(sniff(pngHeader(10, 12_001))).toEqual({ ok: false, reason: 'dimensions' });
    expect(sniff(pngHeader(8_000, 6_000))).toEqual({ ok: false, reason: 'dimensions' });
    expect(sniff(pngHeader(12_000, 3_000))).toMatchObject({ ok: true, width: 12_000 });
  });

  it('an image too long and thin to show: one side over 100 times the other, either way', () => {
    // MEDIA_MAX_ASPECT. Either way, because the binding's EXIF rotation can turn a tall file
    // wide after this has read it.
    expect(sniff(pngHeader(2_001, 20))).toEqual({ ok: false, reason: 'aspect' });
    expect(sniff(pngHeader(20, 2_001))).toEqual({ ok: false, reason: 'aspect' });
    expect(sniff(pngHeader(2_000, 2))).toEqual({ ok: false, reason: 'aspect' });
    expect(sniff(pngHeader(2_000, 20))).toMatchObject({ ok: true, width: 2_000, height: 20 });
    expect(sniff(pngHeader(20, 2_000))).toMatchObject({ ok: true, width: 20, height: 2_000 });
  });

  it('a malformed header: a PNG whose IHDR checksum is wrong, a JPEG without a frame', async () => {
    const png = pngHeader(20, 20);
    png[29] = (png[29] ?? 0) ^ 0xff;
    expect(sniff(png)).toEqual({ ok: false, reason: 'structure' });

    // SOI, then straight to the scan (SOS) with no frame header.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, ...new Uint8Array(20)]);
    expect(sniff(jpeg)).toEqual({ ok: false, reason: 'structure' });

    // An arithmetic-coded frame (SOF9): browsers do not show those either.
    const real = bytes(await solid(16, 16).jpeg().toBuffer());
    const sof = real.findIndex((v, i) => v === 0xff && real[i + 1] === 0xc0);
    real[sof + 1] = 0xc9;
    expect(sniff(real)).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it('a file cut short, and a header that lies past what a probe reads', async () => {
    const jpeg = bytes(await solid(64, 64).jpeg().toBuffer());
    const cut = jpeg.subarray(0, 20);
    expect(sniffImage(cut, cut.length)).toBeNull();
    expect(finish(sniffImage(cut, cut.length), cut.length, cut.length)).toEqual({
      ok: false,
      reason: 'truncated',
    });
    // The same head of a file that goes on: the size is further in than the probe read.
    expect(finish(null, PROBE_MAX_BYTES, PROBE_MAX_BYTES * 2)).toEqual({
      ok: false,
      reason: 'too_complex',
    });

    const webp = bytes(await solid(64, 48).webp().toBuffer());
    expect(sniffImage(webp.subarray(0, 30), 30)).toEqual({ ok: false, reason: 'truncated' });
  });

  it('asks for more bytes rather than guessing on a short head', async () => {
    const jpeg = bytes(await solid(64, 64).jpeg().toBuffer());
    expect(sniffImage(jpeg.subarray(0, 4), jpeg.length)).toBeNull();
    expect(sniffImage(jpeg, jpeg.length)).toMatchObject({ ok: true });
  });
});

describe('the stored WebP: its size, one frame, no metadata', () => {
  it('reads each form of WebP', async () => {
    const forms = [
      await solid(300, 200).webp().toBuffer(),
      await solid(300, 200).webp({ lossless: true }).toBuffer(),
      await sharp({
        create: {
          width: 300,
          height: 200,
          channels: 4,
          background: { r: 1, g: 2, b: 3, alpha: 0.5 },
        },
      })
        .webp()
        .toBuffer(),
    ];
    for (const form of forms) {
      expect(readWebp(bytes(form))).toMatchObject({
        width: 300,
        height: 200,
        animated: false,
        metadata: 0,
      });
    }
  });

  it('refuses a container that is not exactly one WebP', async () => {
    const webp = bytes(await solid(30, 20).webp().toBuffer());
    expect(readWebp(concat([webp, ascii('trailing')]))).toBeNull();
    expect(readWebp(webp.subarray(0, webp.length - 3))).toBeNull();
    expect(readWebp(bytes(await solid(30, 20).png().toBuffer()))).toBeNull();
  });

  it('strips EXIF from a WebP that carries it, clears the flag, and leaves a valid image', async () => {
    const tagged = bytes(
      await solid(80, 60)
        .webp()
        .withExif({ IFD0: { ImageDescription: 'GPS 24.7136 N 46.6753 E', Copyright: 'x' } })
        .toBuffer(),
    );
    expect(readWebp(tagged)?.metadata).toBeGreaterThan(0);
    const clean = stripWebpMetadata(tagged);
    expect(readWebp(clean)).toMatchObject({ width: 80, height: 60, metadata: 0 });
    expect(Buffer.from(clean).includes(Buffer.from('GPS'))).toBe(false);
    expect((clean[20] ?? 0) & 0x08).toBe(0);
    const meta = await sharp(clean).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([80, 60]);
  });

  it('returns a WebP without metadata as it is (no copy)', async () => {
    const plain = bytes(await solid(30, 20).webp().toBuffer());
    expect(stripWebpMetadata(plain)).toBe(plain);
  });
});
