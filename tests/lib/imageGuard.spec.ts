import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  checkImageRequest,
  imageGuardResponse,
  TRANSFORM_WIDTHS,
  ASPECT_TOLERANCE_PX,
  type AssetSize,
} from '@/lib/http/imageGuard';

// `/_image` must answer only the transform URLs this site's markup emits; anything else
// would be a new "unique transformation" against the Images free-plan quota (5,000 a
// month, then error 9422 on every new transform). Built assets are not ESM images under
// vitest, so the rule is exercised against an explicit asset map.

const RIDER = '/_astro/rider.B1x2y3.jpg';
const LOGO = '/_astro/braiin-logo-white.C4d5e6.png';
const assets: ReadonlyMap<string, AssetSize> = new Map([
  [RIDER, { width: 1920, height: 1080 }],
  [LOGO, { width: 900, height: 300 }],
]);

function q(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

const ok = (params: Record<string, string>) => checkImageRequest(q(params), assets).ok;

describe('requests the markup emits are allowed', () => {
  it('a listed width at the asset aspect, in every format Astro emits', () => {
    for (const f of ['avif', 'webp', 'jpg', 'jpeg', 'png']) {
      expect(ok({ href: RIDER, w: '800', h: '450', f })).toBe(true);
    }
  });

  it('the asset at its own width (the <Picture> fallback src and the capped srcset entry)', () => {
    expect(ok({ href: RIDER, w: '1920', h: '1080', f: 'jpg' })).toBe(true);
    // 900 is not a listed width, but it is the logo's own width.
    expect(ok({ href: LOGO, w: '900', h: '300', f: 'png' })).toBe(true);
  });

  it('heights within the rounding tolerance of the aspect', () => {
    // Hero: width 520 → target height round(520 / 3) = 173; 1040 → h = round(1040 / (520/173)) = 346.
    expect(ok({ href: LOGO, w: '520', h: '173', f: 'avif' })).toBe(true);
    expect(ok({ href: LOGO, w: '780', h: '260', f: 'avif' })).toBe(true);
    expect(ok({ href: LOGO, w: '520', h: String(173 + ASPECT_TOLERANCE_PX), f: 'webp' })).toBe(
      true,
    );
  });
});

describe('anything else is refused', () => {
  it('an unknown or remote href', () => {
    expect(ok({ href: '/_astro/other.jpg', w: '800', h: '450', f: 'jpg' })).toBe(false);
    expect(ok({ href: 'https://evil.example/x.jpg', w: '800', h: '450', f: 'jpg' })).toBe(false);
    expect(ok({ w: '800', h: '450', f: 'jpg' })).toBe(false);
  });

  it('a width that is not listed and is not the asset width', () => {
    expect(ok({ href: RIDER, w: '801', h: '451', f: 'jpg' })).toBe(false);
    expect(ok({ href: RIDER, w: '1919', h: '1079', f: 'jpg' })).toBe(false);
  });

  it('a width larger than the source (Astro never upscales)', () => {
    expect(ok({ href: LOGO, w: '1040', h: '347', f: 'png' })).toBe(false);
  });

  it('a height off the aspect', () => {
    expect(ok({ href: RIDER, w: '800', h: '800', f: 'jpg' })).toBe(false);
    expect(ok({ href: RIDER, w: '800', h: String(450 + ASPECT_TOLERANCE_PX + 1), f: 'jpg' })).toBe(
      false,
    );
  });

  it('an unsupported format', () => {
    expect(ok({ href: RIDER, w: '800', h: '450', f: 'gif' })).toBe(false);
    expect(ok({ href: RIDER, w: '800', h: '450' })).toBe(false);
  });

  it('quality, fit and any other parameter', () => {
    expect(ok({ href: RIDER, w: '800', h: '450', f: 'jpg', q: '50' })).toBe(false);
    expect(ok({ href: RIDER, w: '800', h: '450', f: 'jpg', fit: 'cover' })).toBe(false);
    expect(ok({ href: RIDER, w: '800', h: '450', f: 'jpg', position: 'top' })).toBe(false);
    expect(ok({ href: RIDER, w: '800', h: '450', f: 'jpg', x: '1' })).toBe(false);
  });

  it('missing, malformed or repeated dimensions', () => {
    expect(ok({ href: RIDER, h: '450', f: 'jpg' })).toBe(false);
    expect(ok({ href: RIDER, w: '800', f: 'jpg' })).toBe(false);
    expect(ok({ href: RIDER, w: '800.5', h: '450', f: 'jpg' })).toBe(false);
    expect(ok({ href: RIDER, w: '0800', h: '450', f: 'jpg' })).toBe(false);
    expect(ok({ href: RIDER, w: '-800', h: '450', f: 'jpg' })).toBe(false);
    const repeated = new URLSearchParams(`href=${RIDER}&w=800&w=480&h=450&f=jpg`);
    expect(checkImageRequest(repeated, assets).ok).toBe(false);
  });

  it('the refusal is a small, uncacheable 400', async () => {
    const res = imageGuardResponse();
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('Bad image request');
  });
});

// ---- Drift: every width a component asks for is on the list --------------------------

const SRC = join(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(astro|ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Widths requested by public code: widths arrays, Picture width props, getImage caps. */
function requestedWidths(): Map<number, string[]> {
  const found = new Map<number, string[]>();
  const add = (n: number, where: string) => found.set(n, [...(found.get(n) ?? []), where]);
  for (const path of files(SRC)) {
    const rel = relative(process.cwd(), path).replaceAll('\\', '/');
    if (rel.includes('/admin/') || rel.endsWith('imageGuard.ts')) continue;
    const text = readFileSync(path, 'utf8');
    const lists = [
      ...text.matchAll(/widths=\{\[([^\]]*)\]\}/g), // <Picture widths={[…]}>
      ...text.matchAll(/widths\s*[:=]\s*\[([^\]]*)\]/g), // widths: […] / widths = […]
      ...text.matchAll(/_WIDTHS\s*=\s*\[([^\]]*)\]/g), // const INTRO_LOGO_WIDTHS = […]
    ];
    for (const m of lists) {
      for (const n of (m[1] ?? '').split(',').map((s) => Number(s.trim()))) {
        if (Number.isInteger(n) && n > 0) add(n, rel);
      }
    }
    if (text.includes('<Picture')) {
      for (const m of text.matchAll(/\bwidth=\{(\d+)\}/g)) add(Number(m[1]), rel);
    }
    if (text.includes('getImage(')) {
      for (const m of text.matchAll(/width:\s*Math\.min\((\d+),/g)) add(Number(m[1]), rel);
    }
  }
  return found;
}

describe('the allow-list covers every width the public site requests', () => {
  it('finds the known width sources (the scan is not silently empty)', () => {
    const widths = requestedWidths();
    for (const n of [520, 264, 1040, 480, 1600, 1200]) expect(widths.has(n), String(n)).toBe(true);
  });

  it('every requested width is in TRANSFORM_WIDTHS', () => {
    const missing = [...requestedWidths()]
      .filter(([n]) => !TRANSFORM_WIDTHS.has(n))
      .map(([n, where]) => `${n} (${[...new Set(where)].join(', ')})`);
    expect(missing, 'add these to TRANSFORM_WIDTHS in src/lib/http/imageGuard.ts').toEqual([]);
  });
});

// ---- Real assets through Astro's own srcset code -------------------------------------
//
// The rule above is tested against a hand-made map. This runs every bundled image under
// src/assets through Astro's actual `getSrcSet` / `getHTMLAttributes` (the code that
// writes the production URLs) with every width configuration the public site uses, and
// checks that the guard accepts each resulting {href, w, h, f}. It is what proves the
// aspect tolerance and the width rule against real dimensions without a running server.

import sharp from 'sharp';
// The public noop service spreads Astro's baseService, so getSrcSet and getHTMLAttributes
// here ARE the functions the production image service uses to write transform URLs.
import noopService from 'astro/assets/services/noop';

const astro = noopService as unknown as {
  getSrcSet: (options: Record<string, unknown>) => { transform: Transform }[];
  getHTMLAttributes: (options: Record<string, unknown>) => { width: number; height: number };
};

interface Transform {
  width: number;
  height: number;
  format: string;
}

async function bundledAssets(): Promise<
  { href: string; width: number; height: number; format: string }[]
> {
  const out: { href: string; width: number; height: number; format: string }[] = [];
  for (const path of allFiles(join(process.cwd(), 'src', 'assets'))) {
    if (!/\.(jpe?g|png|webp|avif)$/i.test(path)) continue;
    const meta = await sharp(path).metadata();
    let width = meta.width ?? 0;
    let height = meta.height ?? 0;
    if ((meta.orientation ?? 1) >= 5) [width, height] = [height, width];
    const format = meta.format === 'jpeg' ? 'jpg' : String(meta.format);
    const rel = relative(process.cwd(), path).split(sep).join('/');
    out.push({ href: `/_astro/${rel}`, width, height, format });
  }
  return out;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? allFiles(path) : [path];
  });
}

/** Every transform Astro emits for one <Picture>: each srcset entry and the fallback src. */
function pictureTransforms(
  src: { src: string; width: number; height: number; format: string },
  props: { widths: number[]; width?: number; height?: number },
): Transform[] {
  const out: Transform[] = [];
  for (const format of ['avif', 'webp', src.format === 'png' ? 'png' : 'jpg']) {
    const options = { src, format, ...props };
    for (const entry of astro.getSrcSet({ ...options }) as { transform: Transform }[]) {
      out.push({ width: entry.transform.width, height: entry.transform.height, format });
    }
    const attrs = astro.getHTMLAttributes({ ...options }) as {
      width: number;
      height: number;
    };
    out.push({ width: attrs.width, height: attrs.height, format });
  }
  return out;
}

describe('every URL Astro builds for a bundled image passes the guard', () => {
  it('MediaImage, Hero, SiteHeader and getImage across all real assets', async () => {
    const real = await bundledAssets();
    expect(real.length).toBeGreaterThan(10);
    const map = new Map(real.map((a) => [a.href, { width: a.width, height: a.height }]));
    const widthLists = [...new Set([...requestedWidths().keys()])];
    const configs: number[][] = [
      [480, 800, 1200],
      [480, 800, 1200, 1600],
      [640, 960, 1280, 1600],
      [640, 1280, 1600],
      [400, 640, 960],
      [320, 480, 640],
      [176, 264, 352],
      [104],
      [100],
    ];
    const failures: string[] = [];
    const check = (href: string, t: Transform, label: string) => {
      const params = new URLSearchParams({
        href,
        w: String(t.width),
        h: String(t.height),
        f: t.format,
      });
      const verdict = checkImageRequest(params, map);
      if (!verdict.ok)
        failures.push(
          `${label} ${href} w=${t.width} h=${t.height} f=${t.format}: ${verdict.reason}`,
        );
    };

    for (const asset of real) {
      const src = {
        src: asset.href,
        width: asset.width,
        height: asset.height,
        format: asset.format,
      };
      // MediaImage: widths filtered to <= the source width (else the source width), and the
      // real dimensions passed as width/height.
      for (const widths of configs) {
        const usable = widths.filter((w) => w <= asset.width);
        const renderWidths = usable.length > 0 ? usable : [asset.width];
        for (const t of pictureTransforms(src, {
          widths: renderWidths,
          width: asset.width,
          height: asset.height,
        })) {
          check(asset.href, t, 'MediaImage');
        }
      }
      // Hero (width 520) and SiteHeader (width 264): a width prop only, Astro filters.
      for (const t of pictureTransforms(src, { widths: [260, 520, 780, 1040], width: 520 }))
        check(asset.href, t, 'Hero');
      for (const t of pictureTransforms(src, { widths: [176, 264, 352], width: 264 }))
        check(asset.href, t, 'SiteHeader');
      // getImage({ width: Math.min(cap, intrinsic) }) with no height.
      for (const cap of [1200, 1600]) {
        const width = Math.min(cap, asset.width);
        const attrs = astro.getHTMLAttributes({ src, width, format: 'webp' }) as {
          width: number;
          height: number;
        };
        check(
          asset.href,
          { width: attrs.width, height: attrs.height, format: 'webp' },
          `getImage(${cap})`,
        );
      }
    }
    expect(widthLists.length).toBeGreaterThan(5);
    expect(failures.slice(0, 20)).toEqual([]);
  });
});
