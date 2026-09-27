import { handle } from '@astrojs/cloudflare/handler';
import { serveMedia } from './lib/http/media';

// The Worker entry (wrangler.jsonc `main`). It is the adapter's own entry
// (`@astrojs/cloudflare/entrypoints/server` is `{ fetch: handle }`) with ONE route in
// front of it: `/media/*.mp4`, which needs byte ranges the adapter cannot give it — see
// src/lib/http/media.ts for why that cannot be an Astro endpoint or the middleware.
//
// Everything else — every page, endpoint, asset and the middleware's security headers —
// is Astro's `handle`, unchanged.
export default {
  async fetch(request, env, ctx) {
    return (await serveMedia(request, env.ASSETS)) ?? handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
