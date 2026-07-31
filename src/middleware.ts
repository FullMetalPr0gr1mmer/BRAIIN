import { defineMiddleware } from 'astro:middleware';
// Astro 6+ removed `Astro.locals.runtime.env` (the getter now throws). Worker bindings
// come from the runtime module instead — works in `astro dev` (workerd) and in prod.
import { env } from 'cloudflare:workers';
import {
  applySecurityHeaders,
  collectInlineHashes,
  generateNonce,
} from '@/lib/http/securityHeaders';
import { getMaintenanceState, clientIp, maintenanceResponse } from '@/lib/http/maintenance';
import { lookupRedirect } from '@/lib/http/redirects';
import {
  isSameOrigin,
  csrfTokenMatches,
  generateCsrfToken,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_FIELD_NAME,
} from '@/lib/http/csrf';
import { createSessionClient, clearSessionCookies, HOST_COOKIE_BASE } from '@/lib/auth/session';
import { resolveAuthContext } from '@/lib/auth/context';

// Single enforcement point for: maintenance pre-cache check → redirects →
// per-request CSP nonce → strict security headers → admin session + CSRF.
// (CLAUDE.md §8.)
//
// CSP rollout: ship Report-Only for one cycle to collect violations, then flip to
// enforce. Toggle here (or wire to an env flag) — but it ALWAYS ships without
// 'unsafe-inline'.
const CSP_REPORT_ONLY = false;

/** Tier C (CLAUDE.md §2): the admin and its API are never cached, anywhere. */
const PRIVATE_CACHE = 'private, no-store, max-age=0, must-revalidate';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The only two private paths reachable without a session — the login form and the
 * endpoint it posts to. Both still get the CSRF check and `no-store`; what they skip is
 * the authentication gate, which they obviously cannot satisfy.
 */
const LOGIN_PATH = '/admin/login';
const LOGIN_API_PATH = '/api/admin/auth/login';

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': PRIVATE_CACHE },
  });
}

/**
 * Reads the submitted CSRF token. Header first; for ordinary form posts we clone the
 * request and read the hidden field, which is what keeps plain `<form method="post">`
 * working instead of forcing every mutation through fetch(). Multipart bodies (media
 * uploads) are deliberately header-only — buffering a clone of a file upload just to
 * find a 64-byte token trades real memory for nothing.
 */
async function submittedCsrf(request: Request): Promise<string | null> {
  const header = request.headers.get(CSRF_HEADER_NAME);
  if (header) return header;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) return null;
  try {
    const form = await request.clone().formData();
    const value = form.get(CSRF_FIELD_NAME);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url, locals, cookies } = context;

  const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
  const isApi = url.pathname.startsWith('/api/');
  const isAdminApi = url.pathname.startsWith('/api/admin/');
  // /healthz must answer during maintenance. §10 has external synthetic monitors hitting
  // it every 60s; if it 503s the moment maintenance is switched on, planned maintenance
  // pages the on-call — training everyone to ignore the alert that matters.
  const isHealth = url.pathname === '/healthz';
  const isPrivate = isAdmin || isAdminApi;

  // The nonce is minted FIRST, before any early return. Previously it was generated
  // after the maintenance and redirect branches, which meant those two responses left
  // the middleware with no CSP, no HSTS and no nosniff at all — "one enforcement point"
  // held only for the path that reached the bottom of the function. A redirect is
  // exactly where a missing HSTS header matters most (that hop is the downgrade
  // opportunity), and a 503 is served precisely when things are already going wrong.
  const nonce = generateNonce();
  locals.cspNonce = nonce;
  locals.session = null;
  locals.csrfToken = '';

  // `secured()` is the ONLY way a response leaves this middleware.
  //
  // In PRODUCTION, Astro hashes its own inline island bootstrap at build time and hands
  // us those hashes on the response; applySecurityHeaders lifts them into our policy.
  // Astro's DEV server has no CSP code path at all, so in dev we compute the identical
  // hashes from the rendered HTML instead. Without it, dev blocks the `astro-island`
  // custom-element definition and every /admin island renders and then sits inert —
  // and relaxing the policy for dev is the precise divergence that hid this in the
  // first place. Buffering the body is acceptable at dev latency only.
  const secured = async (response: Response): Promise<Response> => {
    const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
    let out = response;
    let extras: { scriptHashes: string[]; styleHashes: string[] } | null = null;
    if (import.meta.env.DEV && isHtml && response.body !== null) {
      const html = await response.text();
      extras = await collectInlineHashes(html);
      out = new Response(html, response);
    }
    applySecurityHeaders(out.headers, {
      nonce,
      reportOnly: CSP_REPORT_ONLY,
      ...(extras ?? {}),
    });
    if (isPrivate) out.headers.set('Cache-Control', PRIVATE_CACHE);
    return out;
  };

  // 1) Maintenance pre-cache check (before edge-cache lookup). /admin, /api and
  //    /healthz exempt.
  if (!isAdmin && !isApi && !isHealth) {
    const m = await getMaintenanceState(env);
    if (m.active) {
      const ip = clientIp(request);
      const allowed = ip !== null && m.allowlist.includes(ip);
      // The 503 page takes the nonce: its styles are in a nonced <style> block, because
      // the CSP it now carries has no 'unsafe-inline' and would blank an inline-styled
      // page. A maintenance notice that renders unstyled is a bad look at a bad time.
      if (!allowed) return secured(maintenanceResponse(nonce));
    }
  }

  // 2) Redirects (301/302/308) — slug/canonical hygiene. Public paths only: the
  //    redirects table is authored by the SEO role, and letting an authored rule shadow
  //    /admin would let a content edit lock everyone out of the CMS.
  if (!isAdmin) {
    const rule = await lookupRedirect(url.pathname, env);
    if (rule) return secured(context.redirect(rule.to, rule.status));
  }

  // 3) Admin: session resolution + CSRF. Everything below is Tier C.
  if (isPrivate) {
    const supabase = createSessionClient(cookies);
    locals.supabase = supabase;

    const { ctx, revoke } = await resolveAuthContext(supabase);
    // A stale or disabled session is torn down here rather than merely ignored, so the
    // browser stops presenting a JWT that RLS would still honour (see auth/context.ts).
    if (revoke) clearSessionCookies(cookies);
    locals.session = ctx;

    // Mint the double-submit token on first contact so the login form itself is
    // protected (login is a state-changing POST too — CSRF-ing a victim into a session
    // the attacker controls is a real attack, not a theoretical one).
    let csrfToken = cookies.get(CSRF_COOKIE_NAME)?.value ?? '';
    if (!csrfToken) {
      csrfToken = generateCsrfToken();
      cookies.set(CSRF_COOKIE_NAME, csrfToken, {
        ...HOST_COOKIE_BASE,
        // Readable by the admin JS on purpose: it authorises nothing by itself, it only
        // proves the request originated from a document on this origin.
        httpOnly: false,
      });
    }
    locals.csrfToken = csrfToken;

    if (!SAFE_METHODS.has(request.method)) {
      if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
        return secured(jsonError(403, 'bad-origin'));
      }
      const cookieToken = cookies.get(CSRF_COOKIE_NAME)?.value ?? null;
      if (!csrfTokenMatches(cookieToken, await submittedCsrf(request))) {
        return secured(jsonError(403, 'csrf'));
      }
    }

    // Authentication gate. Authorization (which capability, which role) is the API
    // kernel's job — this only answers "is there a verified session at all".
    if (!ctx && url.pathname !== LOGIN_PATH && url.pathname !== LOGIN_API_PATH) {
      if (isAdminApi) return secured(jsonError(401, 'unauthenticated'));
      const next = `${url.pathname}${url.search}`;
      return secured(context.redirect(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`, 302));
    }
  }

  // 4) Render, then apply the same headers to the rendered response.
  return secured(await next());
});
