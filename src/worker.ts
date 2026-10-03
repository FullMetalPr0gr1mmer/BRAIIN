import { handle } from '@astrojs/cloudflare/handler';
import { serveMedia } from './lib/http/media';
import { runDailyJobs } from './lib/cron/daily';

// The Worker entry (wrangler.jsonc `main`). It is the adapter's own entry
// (`@astrojs/cloudflare/entrypoints/server` is `{ fetch: handle }`) with ONE route in
// front of it: `/media/*.mp4`, which needs byte ranges the adapter cannot give it — see
// src/lib/http/media.ts for why that cannot be an Astro endpoint or the middleware.
//
// Everything else — every page, endpoint, asset and the middleware's security headers —
// is Astro's `handle`, unchanged.
//
// `scheduled` is the daily cron (wrangler.jsonc `triggers.crons`): the Join retention job —
// expired CVs out of Storage, then their rows — and the limiter's old counters. Importing
// the adapter's handler above is what wires `astro:env` for this path too (it calls
// `setGetEnv` at module load from `cloudflare:workers`' env), so the job uses the same
// service client as every endpoint.
export default {
  async fetch(request, env, ctx) {
    return (await serveMedia(request, env.ASSETS)) ?? handle(request, env, ctx);
  },
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runDailyJobs());
  },
} satisfies ExportedHandler<Env>;
