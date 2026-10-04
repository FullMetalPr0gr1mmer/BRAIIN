import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_OG_IMAGE } from '@/lib/seo/ogImage';

// The committed logo card — public/og/default.jpg, made by scripts/gen-og-image.mjs (owner
// decision H2: the white logo on midnight blue, no other text). Every page with no image of
// its own names it, so the file has to be exactly what the head declares: the size and type
// in its og:image:* tags, light enough for every crawler that unfurls a link, and visibly
// the card (midnight at the edges, the white mark in the middle).

const FILE = `public${DEFAULT_OG_IMAGE.path}`;
const MIDNIGHT = [0, 13, 48]; // #000d30, --bs-midnight

describe('public/og/default.jpg', () => {
  it('is a 1200×630 three-channel JPEG, as the head declares', async () => {
    const meta = await sharp(FILE).metadata();
    expect(meta.format).toBe('jpeg');
    expect(DEFAULT_OG_IMAGE.type).toBe('image/jpeg');
    expect([meta.width, meta.height]).toEqual([DEFAULT_OG_IMAGE.width, DEFAULT_OG_IMAGE.height]);
    expect(meta.channels).toBe(3);
  });

  it('stays under 100 KB', () => {
    expect(statSync(FILE).size).toBeLessThan(100_000);
  });

  it('is midnight at the edges and carries the white mark in the middle', async () => {
    const { data, info } = await sharp(FILE).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    for (const [x, y] of [
      [0, 0],
      [info.width - 1, 0],
      [0, info.height - 1],
      [info.width - 1, info.height - 1],
      [40, info.height >> 1],
    ] as const) {
      pixel(x, y).forEach((v, c) =>
        expect(Math.abs(v - MIDNIGHT[c]!), `(${x},${y})`).toBeLessThanOrEqual(3),
      );
    }
    // The mark: a good share of near-white pixels in the central box, none outside it.
    let white = 0;
    let whiteOutside = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (!pixel(x, y).every((v) => v >= 235)) continue;
        const inside = x >= 300 && x < 900 && y >= 150 && y < 480;
        if (inside) white++;
        else whiteOutside++;
      }
    }
    expect(white).toBeGreaterThan(20_000);
    expect(whiteOutside).toBe(0);
  });
});
