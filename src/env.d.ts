/// <reference path="../.astro/types.d.ts" />

// Cloudflare Workers runtime bindings exposed via `Astro.locals.runtime.env`
// and the platformProxy in dev. Keep in sync with wrangler.jsonc.
type KVNamespace = import('@cloudflare/workers-types').KVNamespace;
type ImagesBinding = import('@cloudflare/workers-types').ImagesBinding;
type Fetcher = import('@cloudflare/workers-types').Fetcher;

interface CloudflareEnv {
  SESSION: KVNamespace;
  IMAGES: ImagesBinding;
  ASSETS: Fetcher;
}

// The Cloudflare adapter provides `Astro.locals.runtime`; we extend it.
type Runtime = import('@astrojs/cloudflare').Runtime<CloudflareEnv>;

declare namespace App {
  interface Locals extends Runtime {
    // Per-request CSP nonce (set in src/middleware.ts; consumed by <SeoHead>).
    cspNonce: string;
    // Resolved auth context (null for anonymous public requests).
    session: import('@/lib/auth/types').AuthContext | null;
  }
}
