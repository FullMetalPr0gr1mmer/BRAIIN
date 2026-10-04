import { handle } from '@astrojs/cloudflare/handler';
import { serveMedia } from './lib/http/media';
import { ensureSecurityHeaders } from './lib/http/securityHeaders';
import { runDailyJobs } from './lib/cron/daily';
import { writeSystemLog } from './lib/data/systemLog';
import { scrubPii } from './lib/log/scrub';

// The Worker entry (wrangler.jsonc `main`). It is the adapter's own entry
// (`@astrojs/cloudflare/entrypoints/server` is `{ fetch: handle }`) with ONE route in
// front of it: `/media/*.mp4`, which needs byte ranges the adapter cannot give it — see
// src/lib/http/media.ts for why that cannot be an Astro endpoint or the middleware.
//
// Everything else — every page, endpoint and the middleware — is Astro's `handle`,
// unchanged, and every response then passes the security-header BACKSTOP
// (`ensureSecurityHeaders`, CLAUDE.md §2 amendment 2026-10). src/middleware.ts is the
// primary enforcement point, but some answers leave Astro without ever reaching it: the
// origin check's cross-site 403, the 400 for a multiply-encoded path, the 301 that
// collapses a duplicate slash (`/about//`), a bare 500, and whatever the adapter passes
// straight from the ASSETS binding (a /media still, any static file a request reaches
// through the Worker). The backstop secures exactly those — keyed on HSTS, so a response
// the middleware (or public/_headers) already secured passes untouched, Report-Only
// included.
//
// A THROWN error becomes a secured, uncached 500 instead of Cloudflare's 1101 error page:
// logged to Workers Logs and to `system_logs` (`source: 'worker'`, the message scrubbed of
// PII — never the request). Under `astro dev` it is rethrown, so the dev server's error
// overlay still shows the stack.
//
// `scheduled` is the daily cron (wrangler.jsonc `triggers.crons`): the Join retention job —
// expired CVs out of Storage, then their rows — and the limiter's old counters. Importing
// the adapter's handler above is what wires `astro:env` for this path too (it calls
// `setGetEnv` at module load from `cloudflare:workers`' env), so the job uses the same
// service client as every endpoint.
export default {
  async fetch(request, env, ctx) {
    try {
      return ensureSecurityHeaders(
        (await serveMedia(request, env.ASSETS)) ?? (await handle(request, env, ctx)),
      );
    } catch (err) {
      if (import.meta.env.DEV) throw err;
      console.error('[worker] unhandled error', err);
      const message = scrubPii(err instanceof Error ? err.message : String(err)).slice(0, 500);
      // writeSystemLog never throws, and is given nothing from the request.
      ctx.waitUntil(
        writeSystemLog({ level: 'error', source: 'worker', message: message || 'unhandled error' }),
      );
      return ensureSecurityHeaders(
        new Response('Internal Server Error', {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        }),
      );
    }
  },
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runDailyJobs());
  },
} satisfies ExportedHandler<Env>;
