import type { APIRoute } from 'astro';
import { ClientLogSchema } from '@schemas/clientlog';
import { scrubPii } from '@/lib/log/scrub';
import { writeSystemLog } from '@/lib/data/systemLog';

// First-party error sink (operational; consent-INdependent). PII is scrubbed server-side
// before anything is persisted, then written to public.system_logs via the service-role
// client with a server-resolved tenant (CLAUDE.md §10).
export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const parsed = ClientLogSchema.safeParse(body);
  if (!parsed.success) {
    return new Response('invalid', { status: 422 });
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
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
