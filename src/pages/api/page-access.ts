import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { PAGE_ACCESS_FIELDS } from '@schemas/visibility';
import { isSameOrigin } from '@/lib/http/csrf';
import { clientIp } from '@/lib/http/maintenance';
import { checkPublicLimits, ipLimitValue } from '@/lib/http/publicRateLimit';
import { HIDDEN_CACHE_CONTROL, decide, getVisibilitySnapshot } from '@/lib/http/visibility';
import { pageAccessSetCookie } from '@/lib/visibility/access';
import {
  isVisibilityPageSlug,
  localizedPagePath,
  type VisibilityPageSlug,
} from '@/lib/visibility/routes';
import { serviceClient } from '@/lib/supabase/server';
import { supabaseConfigured } from '@/lib/supabase/client';
import { writeSystemLog } from '@/lib/data/systemLog';

// POST /api/page-access — the password box's form (Admin v2 U14b). The third public write
// path, after the contact form and Join, and the only one whose body is a secret.
//
// The order is the point; each step refuses before the next costs anything:
//   origin → Content-Length → the snapshot (is this page behind a password at all?) →
//   the limits (FAIL CLOSED) → the bcrypt check in the database → the cookie.
//
// What never happens here: the password is not logged, not audited, not put in a URL, not
// echoed back and not kept anywhere. A refusal is a 303 to the page with `?pa=wrong`, which
// says only that the last try failed; the gate shows a sentence and an empty box. There is
// no audit row because there is no person to name — the caller is anonymous — and a row per
// guess would be a log of guessing, not of access.
//
// The limits are the EXC-004 counter (one Postgres row per window, src/lib/http/
// publicRateLimit.ts) and they FAIL CLOSED: a limiter we cannot reach must not become an
// unlimited bcrypt oracle. Two rules: per address, so one visitor cannot grind; per page,
// so a botnet cannot either. Reaching the per-page ceiling is logged once, as a count.
export const prerender = false;

/** 10 tries every 15 minutes per address, 60 an hour for one page. */
export const PAGE_ACCESS_LIMITS = {
  perIp: { max: 10, windowSeconds: 900 },
  perPage: { max: 60, windowSeconds: 3600 },
} as const;

/** The form is small: a slug, a path and a password. Anything larger is not our form. */
const BODY_MAX_BYTES = 2048;

const NO_STORE = HIDDEN_CACHE_CONTROL;

function refuse(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'cache-control': NO_STORE, 'x-robots-tag': 'noindex' },
  });
}

/** Back to the page, with nothing of what was typed. */
function back(path: string, extra?: Record<string, string>): Response {
  const headers = new Headers({ location: path, 'cache-control': NO_STORE });
  headers.set('x-robots-tag', 'noindex');
  if (extra?.['set-cookie']) headers.append('set-cookie', extra['set-cookie']);
  return new Response(null, { status: 303, headers });
}

export const POST: APIRoute = async ({ request }) => {
  if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
    return refuse(403);
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return refuse(413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(400);
  }
  const slug = form.get(PAGE_ACCESS_FIELDS.page);
  const nextPath = form.get(PAGE_ACCESS_FIELDS.next);
  const password = form.get(PAGE_ACCESS_FIELDS.password);
  if (
    typeof slug !== 'string' ||
    typeof nextPath !== 'string' ||
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > 200 ||
    !isVisibilityPageSlug(slug)
  ) {
    return refuse(400);
  }
  const page: VisibilityPageSlug = slug;
  // `next` is only ever one of the two paths this page has. It is matched, never trusted:
  // an open redirect through a password box would be a gift to a phisher.
  const locale = nextPath === localizedPagePath(page, 'ar') ? 'ar' : 'en';
  if (nextPath !== localizedPagePath(page, locale)) return refuse(400);
  const target = localizedPagePath(page, locale);

  // Is this page behind a password at all, and at which version? The snapshot the gate was
  // built from, read through the same isolate memo, so this costs no KV read of its own.
  const snapshot = await getVisibilitySnapshot(env);
  const gate = decide(snapshot, { kind: 'page', slug: page }, Date.now());
  if (gate.action !== 'password' || !snapshot.tenant) return refuse(400);
  if (!supabaseConfigured()) return refuse(503);

  const sb = serviceClient();
  const tenantId = snapshot.tenant;
  const outcome = await checkPublicLimits(sb, tenantId, LEAD_PII_ENC_KEY, [
    {
      scope: 'page-access:ip',
      value: ipLimitValue(clientIp(request)),
      ...PAGE_ACCESS_LIMITS.perIp,
    },
    { scope: 'page-access:page', value: page, ...PAGE_ACCESS_LIMITS.perPage },
  ]);
  if (outcome !== 'ok') {
    if (outcome === 'limited') {
      // Counts only, never an address and never a password: enough for Site health to show
      // that a page is being guessed at.
      void writeSystemLog({
        level: 'warn',
        source: 'page-access',
        message: 'a page behind a password reached its unlock limit',
        detail: {
          page,
          perIp: PAGE_ACCESS_LIMITS.perIp.max,
          perPage: PAGE_ACCESS_LIMITS.perPage.max,
        },
      });
    }
    return refuse(429);
  }

  let version: number | null = null;
  try {
    const { data, error } = await sb.rpc('page_password_check', {
      p_tenant: tenantId,
      p_page_id: gate.id,
      p_password: password,
    });
    if (error) return refuse(503);
    version = typeof data === 'number' ? data : null;
  } catch {
    return refuse(503);
  }
  if (version === null) return back(`${target}?pa=wrong`);

  return back(target, {
    'set-cookie': await pageAccessSetCookie(LEAD_PII_ENC_KEY, {
      pageId: gate.id,
      pv: version,
    }),
  });
};
