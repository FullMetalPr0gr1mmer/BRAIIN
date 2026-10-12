import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ImageMetadata } from 'astro';
import workerdService from '@astrojs/cloudflare/image-service-workerd';
import {
  checkImageRequest,
  ASPECT_TOLERANCE_PX,
  TRANSFORM_WIDTHS,
  UPLOAD_ASPECT_TOLERANCE_PX,
} from '@/lib/http/imageGuard';
import {
  mediaBucketPrefix,
  storageThumbUrl,
  uploadFallbackFormat,
  uploadedImage,
  uploadedImageSize,
} from '@/lib/media/storageUrl';
import { imageRef } from '@/lib/media/resolve';
import { PublicMediaRowSchema } from '@schemas/content';
import { MEDIA_MAX_ASPECT } from '@schemas/media';
import { PUBLIC_SUPABASE_URL } from '../stubs/astro-env-client';
import {
  mediaRemotePatterns,
  mediaRemotePatternsIntegration,
  readBuildEnv,
} from '../../scripts/media-remote-patterns.mjs';

// How an uploaded image reaches a page (Admin v2 U3): imageRef() turns a public `storage`
// row into image metadata, so <Picture> renders it through same-origin `/_image` like a
// still; the `/_image` guard admits this build's bucket keys at the sizes their names state,
// and nothing else remote; `image.remotePatterns` is exactly that bucket path, from the
// build environment, and a build without it fails.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = `${TENANT}/33333333-3333-4333-8333-333333333333_1200x800.webp`;
const PREFIX = `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/media/`;
const HREF = `${PREFIX}${KEY}`;

const ok = (params: Record<string, string>) =>
  checkImageRequest(new URLSearchParams(params), new Map()).ok;

describe('the /_image guard and uploaded images', () => {
  it('admits a bucket key at a listed width or its own, at its aspect, in the formats asked of it', () => {
    // <Picture>'s avif and webp (its fallback is webp for an upload) and a share image's jpg.
    for (const f of ['avif', 'webp', 'jpg']) {
      expect(ok({ href: HREF, w: '800', h: '533', f }), f).toBe(true);
    }
    // Formats a still may take but nothing asks of an upload: each would be one more unique
    // transformation per size (U3 review).
    for (const f of ['png', 'jpeg', 'gif']) {
      expect(ok({ href: HREF, w: '800', h: '533', f }), f).toBe(false);
    }
    expect(ok({ href: HREF, w: '1200', h: '800', f: 'webp' })).toBe(true);
  });

  it("one height per width (two on a half pixel): Astro's rounding, not a still's two pixels", () => {
    // 1200x800: 800 px wide is 533.33 px high; a still would admit 532 to 535.
    expect(ok({ href: HREF, w: '800', h: '533', f: 'webp' })).toBe(true);
    for (const h of ['532', '534', String(533 + ASPECT_TOLERANCE_PX)]) {
      expect(ok({ href: HREF, w: '800', h, f: 'webp' }), h).toBe(false);
    }
    // 640x427 at 480 px: 320.25, so 320 only.
    const quarter = `${PREFIX}${TENANT}/44444444-4444-4444-8444-444444444444_640x427.webp`;
    expect(ok({ href: quarter, w: '480', h: '320', f: 'avif' })).toBe(true);
    expect(ok({ href: quarter, w: '480', h: '321', f: 'avif' })).toBe(false);
    // 1200x798 at 100 px: exactly 66.5. Astro writes 67 (Math.round); 66 is the only other
    // height within half a pixel, so a float that rounded the other way is still served.
    const half = `${PREFIX}${TENANT}/55555555-5555-4555-8555-555555555555_1200x798.webp`;
    expect(ok({ href: half, w: '100', h: '67', f: 'webp' })).toBe(true);
    expect(ok({ href: half, w: '100', h: '66', f: 'webp' })).toBe(true);
    expect(ok({ href: half, w: '100', h: '68', f: 'webp' })).toBe(false);
    expect(UPLOAD_ASPECT_TOLERANCE_PX).toBe(0.5);
  });

  it('bounds it by the size in its name: never wider, never another aspect or width', () => {
    expect(ok({ href: HREF, w: '1280', h: '853', f: 'webp' })).toBe(false);
    expect(ok({ href: HREF, w: '800', h: '800', f: 'webp' })).toBe(false);
    expect(ok({ href: HREF, w: '801', h: '534', f: 'webp' })).toBe(false);
    expect(ok({ href: HREF, w: '800', h: '533', f: 'webp', q: '40' })).toBe(false);
  });

  it('refuses anything in the bucket that is not an upload key, and every other remote', () => {
    const refused = [
      `${PREFIX}${KEY.replace('.webp', '.png')}`,
      `${PREFIX}${KEY}?download=1`,
      `${PREFIX}../applications/${KEY}`,
      `${PREFIX}${TENANT}/x/33333333-3333-4333-8333-333333333333_1200x800.webp`,
      `${PREFIX}${KEY.toUpperCase()}`,
      `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/applications/${KEY}`,
      `${PUBLIC_SUPABASE_URL}/storage/v1/object/sign/media/${KEY}`,
      `https://other.supabase.co/storage/v1/object/public/media/${KEY}`,
      `http://example.supabase.co/storage/v1/object/public/media/${KEY}`,
      `${PREFIX}${TENANT}/33333333-3333-4333-8333-333333333333_3000x2000.webp`,
    ];
    for (const href of refused) {
      expect(ok({ href, w: '800', h: '533', f: 'webp' }), href).toBe(false);
      expect(uploadedImageSize(href), href).toBeNull();
    }
  });

  it("the admin thumbnail is a URL the guard admits (and so is a narrow image's)", () => {
    const thumb = new URL(storageThumbUrl(KEY)!, 'https://admin.example.test');
    expect(thumb.pathname).toBe('/_image');
    expect(Object.fromEntries(thumb.searchParams)).toEqual({
      href: HREF,
      w: '320',
      h: '213',
      f: 'webp',
    });
    expect(checkImageRequest(thumb.searchParams, new Map()).ok).toBe(true);
    const narrow = `${TENANT}/44444444-4444-4444-8444-444444444444_200x150.webp`;
    const small = new URL(storageThumbUrl(narrow)!, 'https://admin.example.test');
    expect(small.searchParams.get('w')).toBe('200');
    expect(checkImageRequest(small.searchParams, new Map()).ok).toBe(true);
    expect(storageThumbUrl('stills/work/p0.jpg')).toBeNull();
  });

  it('a master too thin to render has no key, so no thumbnail the guard would refuse', () => {
    // 2000x2 at 320 px is 0.32 px high: a thumbnail floored up to 1 px is refused by the
    // guard's half pixel, and every listed width rounds the height to 0 (Astro then drops
    // `h`). Past MEDIA_MAX_ASPECT the key does not parse, so nothing asks for one at all.
    for (const size of ['2000x2', '2560x3', '2000x19', '19x2000']) {
      const thin = `${TENANT}/66666666-6666-4666-8666-666666666666_${size}.webp`;
      expect(storageThumbUrl(thin), size).toBeNull();
      expect(uploadedImage(thin), size).toBeNull();
      expect(uploadedImageSize(`${PREFIX}${thin}`), size).toBeNull();
      expect(ok({ href: `${PREFIX}${thin}`, w: '320', h: '1', f: 'webp' }), size).toBe(false);
    }
  });

  it('the worst case per upload is 69 transformations: 23 sizes in three formats', () => {
    // Found by scanning every size a key may name (both sides 1 to 2,560, within 100 to 1):
    // a 1632x51 master admits the 18 listed widths below its own and its own, four of them
    // at two heights (the exact height a half pixel). Runbook §6i budgets with this number.
    const worst = `${PREFIX}${TENANT}/77777777-7777-4777-8777-777777777777_1632x51.webp`;
    let sizes = 0;
    for (let w = 1; w <= 1632; w += 1) {
      const exact = (w * 51) / 1632;
      for (let h = Math.max(1, Math.floor(exact) - 1); h <= Math.ceil(exact) + 1; h += 1) {
        if (ok({ href: worst, w: String(w), h: String(h), f: 'webp' })) sizes += 1;
      }
    }
    expect(sizes).toBe(23);
    const formats = ['avif', 'webp', 'jpg', 'jpeg', 'png', 'gif'].filter((f) =>
      ok({ href: worst, w: '1632', h: '51', f }),
    );
    expect(sizes * formats.length).toBe(69);
  });
});

describe('every /_image URL a page emits for an upload is one the guard admits', () => {
  // <Picture> cannot be rendered under vitest, so this follows what it does, with Astro's own
  // image service (the workerd one this build uses) computing every transform: one per
  // format in `formats`, plus the fallback for <img src>/srcset, each at the image's width
  // and at every srcset width. The fallback rule is Picture.astro's, and the test reads
  // Picture.astro and MediaImage.astro so neither can move without failing it.
  const picture = readFileSync('node_modules/astro/components/Picture.astro', 'utf8');
  const mediaImage = readFileSync('src/components/media/MediaImage.astro', 'utf8');
  const SPECIAL = ['gif', 'svg', 'jpg', 'jpeg'];

  /** components/Picture.astro: `fallbackFormat ?? (special ESM format ? itself : 'png')`. */
  function pictureFallback(src: ImageMetadata, fallbackFormat: string | undefined): string {
    return fallbackFormat ?? (SPECIAL.includes(src.format) ? src.format : 'png');
  }

  /** The `/_image` parameters Astro's service emits for one format (`getURL`: href, w, h, f). */
  async function transforms(src: ImageMetadata, format: string, widths: number[]) {
    const base = await workerdService.validateOptions!(
      { src, width: src.width, height: src.height, widths, format } as never,
      {} as never,
      {} as never,
    );
    const srcset = await workerdService.getSrcSet!(base, {} as never, {} as never);
    return [base, ...srcset.map((s) => s.transform)].map(
      (t) =>
        new URLSearchParams({
          href: src.src,
          w: String(t.width),
          h: String(t.height),
          f: String(t.format),
        }),
    );
  }

  it('Picture.astro still falls back to png, and MediaImage passes an upload webp', () => {
    expect(picture).toContain("const defaultFallbackFormat = 'png' as const;");
    expect(picture).toContain("const specialFormatsFallback = ['gif', 'svg', 'jpg', 'jpeg']");
    expect(mediaImage).toContain("formats={['avif', 'webp']}");
    expect(mediaImage).toContain('const fallback = uploadFallbackFormat(image.src);');
    expect(mediaImage).toMatch(/\{\.\.\.fallbackProps\}/);
  });

  it('an upload: avif, webp and its webp fallback, at every width, all admitted; no png', async () => {
    const src = uploadedImage(KEY)!;
    const fallback = pictureFallback(src, uploadFallbackFormat(src));
    expect(fallback).toBe('webp');
    const urls: URLSearchParams[] = [];
    for (const widths of [[480, 800, 1200], [320, 640], [1200]]) {
      for (const format of ['avif', 'webp', fallback]) {
        urls.push(...(await transforms(src, format, widths)));
      }
    }
    // The share image (CaseStudyPage, ServicePage) and the breakdown/gallery stills.
    urls.push(...(await transforms(src, 'jpg', [])).slice(0, 1));
    for (const params of urls) {
      expect(checkImageRequest(params, new Map()), params.toString()).toEqual({ ok: true });
      expect(params.get('f')).not.toBe('png');
    }
  });

  it('every key the parser admits renders at every listed width, and its thumbnail is admitted', async () => {
    // MEDIA_MAX_ASPECT is what makes this true: at 100 to 1 the narrowest listed width
    // (100 px) is still a whole pixel high, so Astro never rounds a height to 0.
    expect(Math.min(...TRANSFORM_WIDTHS)).toBeGreaterThanOrEqual(MEDIA_MAX_ASPECT);
    const sizes = [
      [2000, 20],
      [20, 2000],
      [2560, 26],
      [26, 2560],
      [100, 1],
      [1, 100],
      [1632, 51],
      [1200, 798],
    ] as const;
    for (const [w, h] of sizes) {
      const key = `${TENANT}/88888888-8888-4888-8888-888888888888_${w}x${h}.webp`;
      const src = uploadedImage(key);
      expect(src, key).not.toBeNull();
      // MediaImage: the listed widths no wider than the image, else its own.
      const usable = [...TRANSFORM_WIDTHS].filter((x) => x <= w);
      const widths = usable.length > 0 ? usable : [w];
      const urls: URLSearchParams[] = [];
      for (const format of ['avif', 'webp']) urls.push(...(await transforms(src!, format, widths)));
      urls.push(...(await transforms(src!, 'jpg', [])).slice(0, 1));
      urls.push(new URL(storageThumbUrl(key)!, 'https://admin.example.test').searchParams);
      for (const params of urls) {
        expect(Number(params.get('h')), `${key} ${params}`).toBeGreaterThanOrEqual(1);
        expect(checkImageRequest(params, new Map()), `${key} ${params}`).toEqual({ ok: true });
      }
    }
  });

  it("a still keeps Astro's own fallback (its markup is unchanged)", () => {
    const still = { src: '/_astro/rider.B1x2y3.jpg', width: 1920, height: 1080, format: 'jpg' };
    expect(uploadFallbackFormat(still as ImageMetadata)).toBeUndefined();
    expect(pictureFallback(still as ImageMetadata, undefined)).toBe('jpg');
  });
});

describe('imageRef() and uploaded images', () => {
  const row = (over: Record<string, unknown> = {}) =>
    PublicMediaRowSchema.parse({
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'image',
      provider: 'storage',
      storage_path: KEY,
      width: 1200,
      height: 800,
      alt: { en: ' A rider ', ar: 'راكب' },
      stream_uid: null,
      ...over,
    });

  it('resolves a public storage row to image metadata on the bucket, sized by its key', () => {
    expect(imageRef(row())).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      src: { src: HREF, width: 1200, height: 800, format: 'webp' },
      width: 1200,
      height: 800,
      alt: { en: 'A rider', ar: 'راكب' },
    });
    expect(uploadedImage(KEY)).toEqual({ src: HREF, width: 1200, height: 800, format: 'webp' });
  });

  it('a storage row whose path is not an upload key renders nothing', () => {
    expect(imageRef(row({ storage_path: 'https://evil.example/x.webp' }))).toBeNull();
    expect(imageRef(row({ storage_path: `${TENANT}/x.webp` }))).toBeNull();
    expect(imageRef(row({ kind: 'video' }))).toBeNull();
  });

  it('the bucket prefix is the configured project, whatever path the URL carries', () => {
    expect(mediaBucketPrefix()).toBe(PREFIX);
    expect(mediaBucketPrefix('https://p.supabase.co/rest/v1/')).toBe(
      'https://p.supabase.co/storage/v1/object/public/media/',
    );
    expect(mediaBucketPrefix('not a url')).toBeNull();
  });
});

describe('image.remotePatterns from the build environment', () => {
  it('pins protocol, host, port and the bucket path', () => {
    expect(mediaRemotePatterns('https://abc.supabase.co')).toEqual([
      {
        protocol: 'https',
        hostname: 'abc.supabase.co',
        pathname: '/storage/v1/object/public/media/**',
      },
    ]);
    expect(mediaRemotePatterns('http://127.0.0.1:54321')).toEqual([
      {
        protocol: 'http',
        hostname: '127.0.0.1',
        port: '54321',
        pathname: '/storage/v1/object/public/media/**',
      },
    ]);
    for (const bad of [
      '',
      'abc.supabase.co',
      'ftp://abc.supabase.co',
      'https://u:p@abc.supabase.co',
    ]) {
      expect(mediaRemotePatterns(bad), bad).toBeNull();
    }
  });

  it('matches the bucket prefix the code builds (the pattern and the guard agree)', () => {
    const [pattern] = mediaRemotePatterns(PUBLIC_SUPABASE_URL)!;
    const url = new URL(HREF);
    expect(url.protocol).toBe(`${pattern!.protocol}:`);
    expect(url.hostname).toBe(pattern!.hostname);
    expect(url.pathname.startsWith(pattern!.pathname.slice(0, -2))).toBe(true);
  });

  it('reads the shell first, then the .env files', () => {
    expect(
      readBuildEnv('PUBLIC_SUPABASE_URL', {
        env: { PUBLIC_SUPABASE_URL: ' https://a.x ' },
        files: [],
      }),
    ).toBe('https://a.x');
    expect(readBuildEnv('PUBLIC_SUPABASE_URL', { env: {}, files: [] })).toBe('');
  });

  function setup(command: string, env: Record<string, string>) {
    const updateConfig = vi.fn();
    const warn = vi.fn();
    const hook = mediaRemotePatternsIntegration({ env, files: [] }).hooks['astro:config:setup'] as (
      o: unknown,
    ) => void;
    const run = () => hook({ command, updateConfig, logger: { warn } });
    return { run, updateConfig, warn };
  }

  it('sets the pattern for a build, and a build without a usable URL fails', () => {
    const good = setup('build', { PUBLIC_SUPABASE_URL: 'https://abc.supabase.co' });
    good.run();
    expect(good.updateConfig).toHaveBeenCalledWith({
      image: { remotePatterns: mediaRemotePatterns('https://abc.supabase.co') },
    });
    expect(setup('build', {}).run).toThrow(/PUBLIC_SUPABASE_URL is not set/);
    expect(setup('build', { PUBLIC_SUPABASE_URL: 'nope' }).run).toThrow(/not an absolute/);
  });

  it('dev, check and sync only warn, with no pattern', () => {
    for (const command of ['dev', 'sync', 'preview']) {
      const s = setup(command, {});
      expect(s.run).not.toThrow();
      expect(s.updateConfig).not.toHaveBeenCalled();
      expect(s.warn).toHaveBeenCalledOnce();
    }
  });
});
