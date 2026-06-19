import type { APIRoute } from 'astro';
import { StyleFinderInputSchema } from '@schemas/styleFinder';
import { MemoryRateStore, checkRateLimits, styleFinderRules } from '@/lib/ai/rateLimit';
import { ZeroSpendStore, underSpendCap } from '@/lib/ai/spendCap';

// AI Style-Finder — server-side proxy boundary (CLAUDE.md §2/§3). LOGIC IS DEFERRED: this
// returns 501, but with the FULL security/cost envelope a model proxy requires, evaluated
// BEFORE any token spend. There is NO client-side model call, ever, and ANTHROPIC_API_KEY
// is never touched at the stub. Stores are per-isolate placeholders; KV/DO-backed stores +
// the spend alert land at provisioning (KAN-20).
export const prerender = false;

// Module-scoped placeholders (per-isolate). Swapped for KV/DO at provisioning.
const rateStore = new MemoryRateStore();
const spendStore = new ZeroSpendStore();

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export const POST: APIRoute = async ({ request }) => {
  // CSRF / cost-abuse: same-origin only (this endpoint would spend money).
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return json({ ok: false, error: 'bad-origin' }, 403);
    } catch {
      return json({ ok: false, error: 'bad-origin' }, 403);
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad-request' }, 400);
  }

  const parsed = StyleFinderInputSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, error: 'validation' }, 422);

  // Rate limit BEFORE any (future) token spend — per-session 20/hr + per-IP 60/hr.
  const limit = await checkRateLimits(
    rateStore,
    styleFinderRules(clientIp(request), parsed.data.sessionId),
  );
  if (!limit.ok) return json({ ok: false, error: 'rate-limited' }, 429);

  // Daily USD spend cap (breaker). Over cap → 503 (would fall back to cached/rule-based).
  const spend = await underSpendCap(spendStore, 'global');
  if (!spend.ok) return json({ ok: false, error: 'spend-cap' }, 503);

  // Logic deferred — never calls the model; ANTHROPIC_API_KEY untouched. (Phase 4.)
  return json({ ok: false, error: 'not-implemented' }, 501);
};
