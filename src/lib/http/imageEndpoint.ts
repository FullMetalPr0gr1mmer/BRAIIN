import type { APIContext, APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { GET as adapterImageEndpoint } from '@astrojs/cloudflare/image-transform-endpoint';
import { MEDIA_OBJECT_CACHE_SECONDS } from '@/lib/media/storage';
import { uploadedImageSize } from '@/lib/media/storageUrl';
import { checkImageRequest, imageGuardResponse } from './imageGuard';

// The `/_image` endpoint (README H3: "a custom endpoint wraps the adapter"). Registered as
// `image.endpoint` by scripts/image-endpoint.mjs, after the Cloudflare adapter set its own,
// so it is the one route every spelling of `/_image` reaches (`/_image/`, `/%5Fimage`…).
//
//   1. The guard (src/lib/http/imageGuard.ts) runs HERE, on the route itself, whatever path
//      led to it. The middleware runs it too, earlier; this copy is the one no alias of the
//      path can step around.
//   2. A still bundled with the site goes to the adapter's own endpoint, unchanged (its
//      cache, its year-long lifetime, its bytes).
//   3. An editor's upload (a key in this build's public `media` bucket) is fetched here, and
//      the Images binding is called only for a real WebP master: a missing key (Supabase's
//      JSON 400/404), a redirect or any other type is a 404 that costs no transformation.
//      The adapter hands whatever body comes back to the binding, so a random but
//      well-formed key would have cost a binding call each time.
//   4. An upload's derivative is cached for an hour, as its object is
//      (MEDIA_OBJECT_CACHE_SECONDS), not for a year: a deleted or replaced file, an erasure
//      included, leaves the web within about two hours (runbook §6i), where the adapter's
//      `immutable` year kept it in browsers and in this zone's cache for a year.
//   5. An upload is transformed by its width alone (uploadTransform), so the derivative is
//      exactly as wide as the markup asked, never a pixel narrower.

export const prerender = false;

/** How long a derivative of an upload may be cached, by this zone and by a browser. */
export const UPLOAD_DERIVATIVE_MAX_AGE = MEDIA_OBJECT_CACHE_SECONDS;

/** The adapter's default quality (image-binding-transform-stream.js), so stills and uploads match. */
const QUALITY = 85;

const OUTPUT_TYPES = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
} as const;

/** What the Images binding is asked to do with an upload (worker-configuration.d.ts `ImageTransform`). */
export interface UploadTransform {
  width: number;
  fit: 'scale-down';
}

/**
 * The transform for an upload the guard admitted: its width alone, scaled down (never
 * enlarged; the guard already refuses a width past the source's).
 *
 * The URL carries `h` too, because Astro's markup emits it and the guard checks it (within
 * half a pixel of the exact aspect at `w`). But `h` is a rounded number, and given a width and
 * a height the binding fits the image inside that box, keeping its aspect (Cloudflare's
 * "maximum width" and "maximum height"; wrangler dev's local binding treats no `fit` as
 * scale-down). Wherever the rounding went down, the height was the tighter side and the
 * derivative came back a pixel narrower than asked: a 2560x1707 master at `w=320&h=213`
 * (exact 213.375) was 319 px wide, because 213/1707 < 320/2560. Driven by the width alone,
 * the binding keeps the aspect itself, so the derivative is exactly `w` wide and its height is
 * the exact one rounded, the `h` the guard admitted; the two URLs of a half-pixel tie are one
 * transformation, not two. `fit` is stated, not left to a default.
 */
export function uploadTransform(params: URLSearchParams): UploadTransform {
  return { width: Number(params.get('w')), fit: 'scale-down' };
}

/** The part of the Images binding this calls (worker-configuration.d.ts `ImagesBinding`). */
interface ImagesTransformer {
  input(stream: ReadableStream<Uint8Array>): {
    transform(transform: UploadTransform): {
      output(options: {
        format: (typeof OUTPUT_TYPES)[keyof typeof OUTPUT_TYPES];
        quality: number;
      }): Promise<{ response(): Response }>;
    };
  };
}

function noImage(status: 404 | 502): Response {
  return new Response(status === 404 ? 'Not Found' : 'Bad Gateway', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function edgeCache(): Cache | undefined {
  // The Cache API exists in workerd only (and persists on a custom domain, not *.workers.dev).
  return typeof caches === 'undefined'
    ? undefined
    : (caches as unknown as { default?: Cache }).default;
}

export const GET: APIRoute = async (context) => {
  const params = new URL(context.request.url).searchParams;
  if (!checkImageRequest(params).ok) return imageGuardResponse();
  const href = params.get('href') ?? '';
  if (uploadedImageSize(href) === null) return adapterImageEndpoint(context);
  return transformUpload(context, href, params);
};

async function transformUpload(
  context: APIContext,
  href: string,
  params: URLSearchParams,
): Promise<Response> {
  const cache = edgeCache();
  const key = context.request.url;
  const hit = await cache?.match(key);
  if (hit) return hit;

  const images = (env as unknown as { IMAGES?: ImagesTransformer }).IMAGES;
  if (!images) return noImage(404);
  const format = OUTPUT_TYPES[params.get('f') as keyof typeof OUTPUT_TYPES];
  if (!format) return imageGuardResponse();

  let upstream: Response;
  try {
    // `manual`: the bucket answers an object directly; a redirect is not one of our objects.
    upstream = await fetch(href, { redirect: 'manual' });
  } catch {
    return noImage(404);
  }
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (!upstream.ok || type !== 'image/webp' || !upstream.body) {
    void upstream.body?.cancel().catch(() => undefined);
    return noImage(404);
  }

  let transformed: Response;
  try {
    transformed = (
      await images
        .input(upstream.body)
        .transform(uploadTransform(params))
        .output({ format, quality: QUALITY })
    ).response();
  } catch {
    // The binding refused (its monthly quota, error 9422, or a file it cannot read): never cached.
    return noImage(502);
  }
  if (!transformed.ok || !transformed.body) return noImage(502);

  const headers = new Headers(transformed.headers);
  headers.set('Cache-Control', `public, max-age=${UPLOAD_DERIVATIVE_MAX_AGE}`);
  const response = new Response(transformed.body, { status: 200, headers });
  if (cache) context.locals.cfContext?.waitUntil(cache.put(key, response.clone()));
  return response;
}
