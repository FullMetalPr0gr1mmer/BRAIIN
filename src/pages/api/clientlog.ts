import type { APIRoute } from 'astro';
import { ClientLogSchema } from '@schemas/clientlog';

// First-party error sink (operational; consent-INdependent). PII is scrubbed before
// anything is persisted. The Sentry same-origin tunnel + system_logs insert plug in
// here at provisioning (CLAUDE.md §10).
export const prerender = false;

/** Strip emails and phone-like number runs from free text before persistence. */
function scrub(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]');
}

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

  const entry = { ...parsed.data, message: scrub(parsed.data.message) };
  // TODO(provisioning): insert `entry` into public.system_logs via the service-role
  // client (tenant-scoped) and forward to Sentry via the same-origin tunnel.
  void entry;

  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
