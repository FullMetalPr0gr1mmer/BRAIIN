import type { ImageMetadata } from 'astro';

// The public image transform endpoint (`/_image`, the adapter's cloudflare-binding
// service) transforms whatever `w`, `h`, `q`, `f` and `fit` it is given. Each distinct
// combination is a separate "unique transformation", and the Cloudflare Images free plan
// allows 5,000 a month. Past that, new transforms fail with error 9422 and every image
// that needs one breaks, LCP posters included. Nothing caches `/_image` responses on
// *.workers.dev (the Cache API does not persist there), so anyone could exhaust the
// quota by requesting the same file at a few thousand widths.
//
// The rule: `/_image` answers only requests this site's own markup can emit. Astro's
// image service builds every transform URL from exactly four parameters (`href`, `w`,
// `h`, `f`: node_modules/astro/dist/assets/services/service.js `getURL`), and none of our
// components sets `quality`, `fit`, `position` or `background`. So:
//   - href: a bundled image under src/assets. Never remote (`image.domains` is empty).
//   - f:    avif | webp | jpg | jpeg | png.
//   - w:    a width a component asks for (TRANSFORM_WIDTHS) or the asset's own width,
//           never wider than the asset (Astro never upscales; `getSrcSet` caps at it).
//   - h:    the asset's aspect at that width, within rounding (ASPECT_TOLERANCE_PX):
//           every <Picture> uses the asset's own aspect (MediaImage passes the real
//           dimensions; Hero and SiteHeader pass a width only).
//   - nothing else.
// tests/lib/imageGuard.spec.ts holds the widths in components to this list, so adding a
// new width without adding it here fails CI instead of breaking an image in production.

const IMAGES = import.meta.glob<ImageMetadata>('/src/assets/**/*.{jpg,jpeg,png,webp,avif}', {
  eager: true,
  import: 'default',
});

export interface AssetSize {
  width: number;
  height: number;
}

/** Built asset URL (what Astro puts in `href`) → its intrinsic size. */
export const BUNDLED_IMAGES: ReadonlyMap<string, AssetSize> = new Map(
  Object.values(IMAGES)
    // Outside an Astro build (vitest) an image import is a plain URL string; skip it.
    .filter((image) => typeof image === 'object' && image !== null)
    .map((image) => [image.src, { width: image.width, height: image.height }]),
);

/**
 * Every width a component requests: `widths` arrays, Picture `width` props and the caps
 * in `getImage({ width: Math.min(cap, …) })`. A request below an asset's own width must
 * be one of these.
 */
export const TRANSFORM_WIDTHS: ReadonlySet<number> = new Set([
  100, 104, 176, 260, 264, 320, 352, 400, 480, 520, 640, 780, 800, 960, 1040, 1200, 1280, 1600,
]);

export const TRANSFORM_FORMATS: ReadonlySet<string> = new Set([
  'avif',
  'webp',
  'jpg',
  'jpeg',
  'png',
]);

/** Astro derives `h` from rounded target dimensions, so it can drift a pixel or two. */
export const ASPECT_TOLERANCE_PX = 2;

const ALLOWED_PARAMS = new Set(['href', 'w', 'h', 'f']);
const INT = /^[1-9]\d{0,4}$/;

export type ImageGuardResult = { ok: true } | { ok: false; reason: string };

export function checkImageRequest(
  params: URLSearchParams,
  assets: ReadonlyMap<string, AssetSize> = BUNDLED_IMAGES,
): ImageGuardResult {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return { ok: false, reason: `parameter ${key}` };
    if (seen.has(key)) return { ok: false, reason: `repeated ${key}` };
    seen.add(key);
  }

  const href = params.get('href');
  const asset = href === null ? undefined : assets.get(href);
  if (!asset) return { ok: false, reason: 'href' };

  const format = params.get('f');
  if (format === null || !TRANSFORM_FORMATS.has(format)) return { ok: false, reason: 'format' };

  const w = params.get('w');
  const h = params.get('h');
  if (w === null || h === null || !INT.test(w) || !INT.test(h)) {
    return { ok: false, reason: 'dimensions' };
  }
  const width = Number(w);
  const height = Number(h);
  if (width > asset.width) return { ok: false, reason: 'wider than the source' };
  if (width !== asset.width && !TRANSFORM_WIDTHS.has(width)) return { ok: false, reason: 'width' };

  const expected = (width * asset.height) / asset.width;
  if (Math.abs(height - expected) > ASPECT_TOLERANCE_PX) return { ok: false, reason: 'aspect' };

  return { ok: true };
}

/** The refusal: tiny, uncacheable, and silent about which rule failed. */
export function imageGuardResponse(): Response {
  return new Response('Bad image request', {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
