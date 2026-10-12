import type { ImageMetadata } from 'astro';
import { uploadedImageSize } from '@/lib/media/storageUrl';

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
//   - href: a bundled image under src/assets, or an image an editor uploaded (Admin v2 U3):
//           a key in this build's public `media` bucket, whose size is written in the key
//           (`<tenant>/<id>_<w>x<h>.webp`, held equal to the row by the 0045 CHECK), so it
//           is bounded like a bundled one without a database read. No other remote URL
//           (`image.domains` is empty; `image.remotePatterns` names only that bucket path).
//           Whether such a key names a real object is the endpoint's question
//           (src/lib/http/imageEndpoint.ts), asked before any transformation.
//   - f:    avif | webp | jpg | jpeg | png for a bundled image; for an upload only what the
//           markup asks of one (UPLOAD_TRANSFORM_FORMATS): avif and webp from <Picture>
//           (its fallback is webp too, MediaImage), jpg from the share images.
//   - w:    a width a component asks for (TRANSFORM_WIDTHS) or the asset's own width,
//           never wider than the asset (Astro never upscales; `getSrcSet` caps at it).
//   - h:    the asset's aspect at that width, within rounding (ASPECT_TOLERANCE_PX):
//           every <Picture> uses the asset's own aspect (MediaImage passes the real
//           dimensions; Hero and SiteHeader pass a width only). An upload reaches only
//           MediaImage (its real size) and getImage() with a width alone, so Astro rounds
//           the exact aspect once: its height is within half a pixel of it
//           (UPLOAD_ASPECT_TOLERANCE_PX), one height per width, not five.
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

/**
 * The formats an uploaded image is asked for: <Picture>'s avif and webp (MediaImage gives an
 * upload a webp fallback, not Astro's default png) and the 1,200 px jpg of a share image
 * (CaseStudyPage, ServicePage). Every other format is a unique transformation nothing shows.
 */
export const UPLOAD_TRANSFORM_FORMATS: ReadonlySet<string> = new Set(['avif', 'webp', 'jpg']);

/** Astro derives `h` from rounded target dimensions, so it can drift a pixel or two. */
export const ASPECT_TOLERANCE_PX = 2;

/**
 * An upload's `h` is `Math.round(w / (W / H))` on every path that can render one (MediaImage,
 * and getImage() with a width alone), so it is within half a pixel of the exact aspect. Two
 * pixels either side would admit five heights at every width, five times the transformations.
 */
export const UPLOAD_ASPECT_TOLERANCE_PX = 0.5;

/** The route Astro serves image transforms on (`image.endpoint.route`, the default). */
export const IMAGE_ENDPOINT_ROUTE = '/_image';

/**
 * Is this request for the image endpoint? By the route Astro matched, which is what decides
 * the handler: Astro matches routes on the DECODED path with the trailing slash ignored
 * (`trailingSlash: 'ignore'`), so `/_image/`, `/%5Fimage` and `/_imag%65/` all reach the
 * same endpoint, and a guard keyed on the spelling `/_image` let each of them through. The
 * path is checked too, decoded and normalised the way Astro's router does it, for a caller
 * that has no route (a test, a future handler in front of Astro).
 */
export function isImageEndpoint(routePattern: string | undefined, pathname: string): boolean {
  if (routePattern === IMAGE_ENDPOINT_ROUTE) return true;
  let path = pathname;
  // Astro decodes repeatedly (core/util/pathname.ts validateAndDecodePathname, ten times at
  // most); so does this.
  for (let i = 0; i < 10; i += 1) {
    let decoded: string;
    try {
      decoded = decodeURI(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return path === IMAGE_ENDPOINT_ROUTE;
}

const ALLOWED_PARAMS = new Set(['href', 'w', 'h', 'f']);
const INT = /^[1-9]\d{0,4}$/;

export type ImageGuardResult = { ok: true } | { ok: false; reason: string };

export function checkImageRequest(
  params: URLSearchParams,
  assets: ReadonlyMap<string, AssetSize> = BUNDLED_IMAGES,
  uploaded: (href: string) => AssetSize | null = uploadedImageSize,
): ImageGuardResult {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return { ok: false, reason: `parameter ${key}` };
    if (seen.has(key)) return { ok: false, reason: `repeated ${key}` };
    seen.add(key);
  }

  const href = params.get('href');
  const bundled = href === null ? undefined : assets.get(href);
  const upload = href === null || bundled ? null : uploaded(href);
  const asset = bundled ?? upload;
  if (!asset) return { ok: false, reason: 'href' };

  const format = params.get('f');
  const formats = upload ? UPLOAD_TRANSFORM_FORMATS : TRANSFORM_FORMATS;
  if (format === null || !formats.has(format)) return { ok: false, reason: 'format' };

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
  const tolerance = upload ? UPLOAD_ASPECT_TOLERANCE_PX : ASPECT_TOLERANCE_PX;
  if (Math.abs(height - expected) > tolerance) return { ok: false, reason: 'aspect' };

  return { ok: true };
}

/** The refusal: tiny, uncacheable, and silent about which rule failed. */
export function imageGuardResponse(): Response {
  return new Response('Bad image request', {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
