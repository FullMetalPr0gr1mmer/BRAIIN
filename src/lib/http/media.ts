import { StaticVideoPathSchema } from '@schemas/media';
import { contentRange, ifRangeAllows, parseRange, sliceStream } from './range';
import { generateNonce, withSecurityHeaders } from './securityHeaders';

// `/media/*.mp4` with byte ranges — the self-hosted showreel of EXC-009, served through the
// Worker so a <video> can seek (docs/security-exceptions.md EXC-009).
//
// WHY THE WORKER ENTRY, not an Astro endpoint or the middleware: the adapter's handler
// (`@astrojs/cloudflare/handler`) answers any path in `manifest.assets` — every file in
// dist/client, public/ included — with `env.ASSETS.fetch(url)` BEFORE routing, and it passes
// the URL only, so the `Range` header is dropped and neither an endpoint nor the middleware
// ever sees the request. src/worker.ts therefore calls this first and hands everything else
// to Astro. `assets.run_worker_first: ["/media/*"]` (wrangler.jsonc) is what routes these
// paths to the Worker at all; without it the asset worker answers them directly, and it
// ignores Range.
//
// No recursion: a fetch on the ASSETS binding goes straight to the asset worker —
// `run_worker_first` applies to incoming requests only.
//
// The client's `Range` is NOT forwarded upstream: the asset worker (production, and
// miniflare's copy under `wrangler dev`) has no range support, so the store always returns
// the whole file with its length and the window is cut here (range.ts `sliceStream`).

/**
 * A day fresh, a week stale-while-revalidate. Not `immutable`: the name is not content
 * hashed, so a replaced file must be picked up — the ETag keeps revalidation cheap.
 */
export const MEDIA_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

/** Validators forwarded to the asset store, so a revalidation can come back 304. */
const CONDITIONAL = ['if-none-match', 'if-modified-since'] as const;

type AssetFetcher = { fetch(input: Request): Promise<Response> };

/**
 * Whether the Worker serves this path itself. The allow-list is the `VideoClip` schema's —
 * the same pattern as its DB CHECK, EXC-009's fence: under /media only, `.mp4` only, and no
 * `.` before the extension, so no `..` and no encoded escape. `//` is refused as well: it
 * would name the same file under a second URL.
 */
export function isMediaPath(pathname: string): boolean {
  return StaticVideoPathSchema.safeParse(pathname).success && !pathname.includes('//');
}

function secured(response: Response): Response {
  return withSecurityHeaders(response, { nonce: generateNonce() });
}

/** The headers every media response carries, whatever its status. */
function baseHeaders(upstream: Response): Headers {
  const headers = new Headers({
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': MEDIA_CACHE_CONTROL,
  });
  for (const name of ['etag', 'last-modified'] as const) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** A body of known length. workerd's FixedLengthStream makes the Content-Length stick. */
function fixedLength(body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const Fixed = (
    globalThis as {
      FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).FixedLengthStream;
  return Fixed ? body.pipeThrough(new Fixed(length)) : body;
}

/**
 * Answer a `/media/*.mp4` request with range support, or `null` when the path is not ours
 * (or the file does not exist) so the caller falls through to Astro — which renders the
 * real 404 page.
 */
export async function serveMedia(request: Request, assets: AssetFetcher): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isMediaPath(url.pathname)) return null;

  const isHead = request.method === 'HEAD';
  if (request.method !== 'GET' && !isHead) {
    return secured(
      new Response(null, {
        status: 405,
        headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' },
      }),
    );
  }

  // Only the validators travel upstream — never cookies, never the client's other headers.
  // Always a GET: a HEAD needs the size, and the body is cancelled below without reading.
  const forward = new Headers();
  for (const name of CONDITIONAL) {
    const value = request.headers.get(name);
    if (value !== null) forward.set(name, value);
  }
  const upstream = await assets.fetch(
    new Request(new URL(url.pathname, url.origin), { method: 'GET', headers: forward }),
  );

  if (upstream.status === 304) {
    await upstream.body?.cancel();
    return secured(new Response(null, { status: 304, headers: baseHeaders(upstream) }));
  }
  if (upstream.status !== 200 || upstream.body === null) {
    await upstream.body?.cancel();
    return null;
  }

  const headers = baseHeaders(upstream);
  let body: ReadableStream<Uint8Array> = upstream.body;
  let size = Number(upstream.headers.get('content-length') ?? NaN);
  if (!Number.isSafeInteger(size) || size < 0) {
    // No length from the store: buffer once rather than guess. Not expected — the asset
    // worker sends one for every file — but a range answer without a size is not possible.
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    size = bytes.byteLength;
    body = new Response(bytes).body ?? new ReadableStream({ start: (c) => c.close() });
  }

  const decision = ifRangeAllows(request.headers.get('if-range'), {
    etag: headers.get('etag'),
    lastModified: headers.get('last-modified'),
  })
    ? parseRange(request.headers.get('range'), size)
    : ({ kind: 'full' } as const);

  if (decision.kind === 'unsatisfiable') {
    await body.cancel();
    headers.set('content-range', contentRange(size));
    headers.set('content-length', '0');
    return secured(new Response(null, { status: 416, headers }));
  }

  const partial = decision.kind === 'partial';
  const length = partial ? decision.end - decision.start + 1 : size;
  headers.set('content-length', String(length));
  if (partial) headers.set('content-range', contentRange(size, decision));

  if (isHead) {
    await body.cancel();
    return secured(new Response(null, { status: partial ? 206 : 200, headers }));
  }
  const out = partial ? sliceStream(body, decision.start, decision.end) : body;
  return secured(new Response(fixedLength(out, length), { status: partial ? 206 : 200, headers }));
}
