import type { APIRoute } from 'astro';

// Liveness probe for the synthetic monitors (CLAUDE.md §10 — hit alongside `/` and `/ar/`
// every 60s from outside Cloudflare).
//
// Deliberately minimal: it proves the Worker is serving, nothing more. No dependency
// probe — a DB round-trip every 60s adds load and would turn a transient Supabase blip
// into a false "site down" page; readiness of a dependency belongs in its own check.
// No build/infra details either (an unauthenticated endpoint shouldn't leak internals).
export const prerender = false;

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ ok: true, service: 'braiin-station' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
