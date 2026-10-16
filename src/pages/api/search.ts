import type { APIRoute } from 'astro';
// Worker bindings come from the runtime module (Astro 6+ removed `locals.runtime.env`).
import { env } from 'cloudflare:workers';
import { SearchQuerySchema } from '@schemas/search';
import { searchContent, searchSuggest } from '@/lib/data/search';
import { recordSearchQuery } from '@/lib/data/telemetry';
import { getVisibilitySnapshot } from '@/lib/http/visibility';
import { listedSearchHits } from '@/lib/visibility/listing';

// Public unified-search endpoint (KAN-29). NOT captcha-gated; the safety envelope is the
// Zod cap (≤64 chars, no control chars) + websearch_to_tsquery + per-call statement_timeout
// (both inside the search_content RPC) + capped rows + WAF rate-limit (KAN-20).
// GET = idempotent read (no mutation → no CSRF check needed). no-store so query strings are
// never shared-cached. Results — and the page rendering them — are noindex.
export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = async ({ url }) => {
  // TODO(KAN-20): WAF rate-limit /api/search at 30 req/min/IP (Cloudflare rule).
  const parsed = SearchQuerySchema.safeParse({
    q: url.searchParams.get('q') ?? '',
    locale: url.searchParams.get('locale') ?? 'en',
  });
  if (!parsed.success) return json({ ok: false, error: 'validation', results: [] }, 422);

  const { q, locale } = parsed.data;
  // Page visibility (Admin v2 U14a): no hit under a hidden template. /api is not gated by the
  // middleware, so the endpoint reads the snapshot itself, through the same isolate memo.
  const visibility = await getVisibilitySnapshot(env);
  const now = Date.now();
  const results = listedSearchHits(await searchContent(q, locale), visibility, now);
  // Did-you-mean only when the primary search came back empty.
  const suggestions =
    results.length === 0 ? listedSearchHits(await searchSuggest(q, locale), visibility, now) : [];

  // Feeds the SEO role's zero-result report. Not consent-gated and carrying no session
  // id: what is stored is the query and its result count — a property of the CONTENT,
  // not of the person — so there is nothing here to tie back to a visitor. See
  // `recordSearchQuery`. Never awaited into the failure path: a logging problem must
  // not turn a working search into an error.
  await recordSearchQuery(q, locale, results.length);

  return json({ ok: true, query: q, locale, results, suggestions }, 200);
};
