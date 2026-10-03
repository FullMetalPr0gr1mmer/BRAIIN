import type { APIRoute } from 'astro';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import {
  APPLY_BODY_MAX_BYTES,
  APPLY_HTTP_STATUS,
  ApplicationInputSchema,
  CV_FIELD,
  CV_MAX_BYTES,
  HONEYPOT_FIELD,
  formToApplicationInput,
  type ApplyStatus,
} from '@schemas/application';
import { isSameOrigin } from '@/lib/http/csrf';
import { clientIp } from '@/lib/http/maintenance';
import { APPLY_LIMITS, checkPublicLimits, ipLimitValue } from '@/lib/http/publicRateLimit';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { resolveLaunchTenantId } from '@/lib/data/tenant';
import { sniffCv } from '@/lib/applications/fileSniff';
import { createApplication } from '@/lib/applications/create';
import { writeSystemLog } from '@/lib/data/systemLog';

// POST /api/apply — the Join form (careers). The second public write path after the
// contact form, and the only one that accepts a file. Built for the Workers FREE plan:
// the body is parsed by the runtime's native multipart parser, the CV is checked by its
// head and tail only (src/lib/applications/fileSniff.ts), and the file goes to a private
// Supabase Storage bucket (owner decision J1).
//
// The order is the point — each step refuses before the next costs anything:
//   origin → multipart → Content-Length (411/413, before reading a byte) → configured →
//   tenant (server-side, the anon fence) → applications open (re-read, never the cached
//   page's copy) → per-IP limit (FAILS CLOSED, EXC-004) → parse → honeypot (silent ok) →
//   strict schema (422 + field names) → CV size and sniff → per-e-mail limit → store.
//
// Answers: `{ status }` (+ `fields` on a 422) with `Accept: application/json`, else a 303
// to `/join?status=…#apply` (`/ar/join…` for an Arabic form) so the page works without
// JavaScript. A cross-origin call gets a plain 403 and never a redirect.
export const prerender = false;

const NO_STORE = 'no-store';

function localeOf(request: Request, formLocale?: string): 'en' | 'ar' {
  if (formLocale === 'ar' || formLocale === 'en') return formLocale;
  try {
    const ref = request.headers.get('referer');
    if (ref && new URL(ref).pathname.startsWith('/ar/')) return 'ar';
  } catch {
    // no usable referer
  }
  return 'en';
}

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  let locale: 'en' | 'ar' = localeOf(request);

  const answer = (status: ApplyStatus, opts: { http?: number; fields?: string[] } = {}) => {
    const http = opts.http ?? APPLY_HTTP_STATUS[status];
    if (wantsJson) {
      return new Response(
        JSON.stringify(opts.fields ? { status, fields: opts.fields } : { status }),
        {
          status: http,
          headers: { 'content-type': 'application/json', 'cache-control': NO_STORE },
        },
      );
    }
    const page = locale === 'ar' ? '/ar/join' : '/join';
    return new Response(null, {
      status: 303,
      headers: { location: `${page}?status=${status}#apply`, 'cache-control': NO_STORE },
    });
  };

  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return new Response(JSON.stringify({ status: 'error' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'cache-control': NO_STORE },
    });
  }
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('multipart/form-data'))
    return answer('invalid', { http: 415 });

  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader === null) return answer('invalid', { http: 411 });
  const length = Number(lengthHeader);
  if (!Number.isFinite(length) || length < 0) return answer('invalid', { http: 400 });
  if (length > APPLY_BODY_MAX_BYTES) return answer('too_large');

  if (!supabaseConfigured()) return answer('unavailable');
  const svc = serviceClient();
  const tenantId = await resolveLaunchTenantId();
  if (!tenantId) return answer('unavailable');

  // The page is edge-cached; the flag is not. Fail closed: unknown means closed-for-now.
  const { data: profile, error: profileError } = await svc
    .from('site_profile')
    .select('accepting_applications')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (profileError) return answer('unavailable');
  if ((profile as { accepting_applications?: unknown } | null)?.accepting_applications !== true) {
    return answer('closed');
  }

  const ip = ipLimitValue(clientIp(request));
  const ipLimit = await checkPublicLimits(svc, tenantId, LEAD_PII_ENC_KEY, [
    { scope: 'apply:ip', value: ip, ...APPLY_LIMITS.perIp },
  ]);
  if (ipLimit === 'limited') return answer('rate_limited');
  if (ipLimit === 'unavailable') return answer('unavailable');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer('invalid', { http: 400 });
  }
  const formLocale = form.get('locale');
  locale = localeOf(request, typeof formLocale === 'string' ? formLocale : undefined);

  // A filled honeypot is a bot: tell it "ok", store nothing, learn it nothing.
  const hp = form.get(HONEYPOT_FIELD);
  if (typeof hp === 'string' && hp !== '') return answer('ok');

  const parsed = ApplicationInputSchema.safeParse(formToApplicationInput(form));
  if (!parsed.success) {
    const fields = [
      ...new Set(
        parsed.error.issues.map((i) => i.path[0]).filter((k): k is string => typeof k === 'string'),
      ),
    ];
    return answer('invalid', { fields });
  }
  const input = parsed.data;

  // The CV is optional; an empty file input arrives as a zero-byte File.
  const raw = form.get(CV_FIELD);
  let cv: { file: Blob; kind: 'pdf' | 'docx' } | null = null;
  if (raw instanceof Blob && raw.size > 0) {
    if (raw.size > CV_MAX_BYTES) return answer('too_large');
    const sniff = await sniffCv(raw);
    if (!sniff.ok) return answer('bad_type');
    cv = { file: raw, kind: sniff.kind };
  }

  // The per-e-mail limit counts only an application that would be stored. Counted earlier,
  // a stranger who knows someone's address could spend that person's daily allowance with
  // refused uploads — locking them out, and learning from the 429 whether they had applied.
  const emailLimit = await checkPublicLimits(svc, tenantId, LEAD_PII_ENC_KEY, [
    { scope: 'apply:email', value: input.email, ...APPLY_LIMITS.perEmail },
  ]);
  if (emailLimit === 'limited') return answer('rate_limited');
  if (emailLimit === 'unavailable') return answer('unavailable');

  const result = await createApplication(svc, tenantId, input, cv, LEAD_PII_ENC_KEY);
  if (!result.ok) {
    // The reason only — never a field value. Awaited: a Worker may cancel I/O still running
    // after the response, and this is the only trace a failed application leaves.
    await writeSystemLog({
      level: 'error',
      source: 'apply',
      message: `application not stored (${result.reason})`,
      detail: { reason: result.reason, withCv: cv !== null },
    });
    return answer('error');
  }
  return answer('ok');
};
