import type { APIRoute } from 'astro';
import { ClientLogSchema } from '@schemas/clientlog';
import { isSameOrigin } from '@/lib/http/csrf';
import { scrubPii } from '@/lib/log/scrub';
import { writeSystemLog } from '@/lib/data/systemLog';

// First-party error sink (operational; consent-INdependent — §10 lists errors under
// service operation, not the §7 consent-gated set). PII is scrubbed server-side before
// anything is persisted, then written to public.system_logs via the service-role client
// with a server-resolved tenant (CLAUDE.md §10).
export const prerender = false;

// Tier C: `private, no-store` on EVERY branch, not just the happy path. The 400/422
// replies previously carried no cache header at all, and neither middleware nor
// applySecurityHeaders adds one — so an intermediary was free to cache them.
const NO_STORE = { 'cache-control': 'private, no-store' } as const;

export const POST: APIRoute = async ({ request }) => {
  // Explicit same-origin check rather than relying only on Astro's `security.checkOrigin`.
  // That built-in only rejects cross-origin requests whose content-type is form-like, so
  // a cross-origin `application/json` POST sails through — and this endpoint reaches an
  // RLS-BYPASSING service-role insert. Two independent layers, per Pillar 1.
  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return new Response('bad origin', { status: 403, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400, headers: NO_STORE });
  }

  const parsed = ClientLogSchema.safeParse(body);
  if (!parsed.success) {
    return new Response('invalid', { status: 422, headers: NO_STORE });
  }

  // Scrub BOTH the message and the path — a query string can carry an email/phone.
  const message = scrubPii(parsed.data.message);
  const path = scrubPii(parsed.data.path);

  // Fire-and-forget by contract: writeSystemLog never throws and no-ops until Supabase
  // is provisioned, so a logging failure can never turn into a failed client request.
  await writeSystemLog({
    level: parsed.data.level,
    message,
    source: parsed.data.source ?? 'client',
    detail: { path, line: parsed.data.line ?? null, col: parsed.data.col ?? null },
  });

  // TODO(KAN-21): also forward to Sentry via the same-origin tunnel once the DSN exists.
  // TODO(KAN-20): WAF rate-limit /api/clientlog per IP. Unauthenticated → service-role
  // INSERT is the highest-value unrated path in the app; the Zod caps bound each row's
  // size but nothing yet bounds the number of rows.
  return new Response(null, { status: 204, headers: NO_STORE });
};
