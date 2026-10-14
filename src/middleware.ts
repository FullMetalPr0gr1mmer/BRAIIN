import { defineMiddleware } from 'astro:middleware';
// Astro 6+ removed `Astro.locals.runtime.env` (the getter now throws). Worker bindings
// come from the runtime module instead — works in `astro dev` (workerd) and in prod.
import { env } from 'cloudflare:workers';
import {
  CSP_REPORT_ONLY,
  collectInlineHashes,
  generateNonce,
  withSecurityHeaders,
} from '@/lib/http/securityHeaders';
import { getMaintenanceState, clientIp, maintenanceResponse } from '@/lib/http/maintenance';
import { getRedirectMap, lookupRedirect, redirectResponse } from '@/lib/http/redirects';
import { checkImageRequest, imageGuardResponse, isImageEndpoint } from '@/lib/http/imageGuard';
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
import { expiredSignInForm, tooLargeSignInForm } from '@/lib/auth/expiredForm';
import { PRIVATE_FORM_BODY_LIMIT, bodyWithinLimit } from '@/lib/auth/bodyLimit';

// The PRIMARY enforcement point for: maintenance pre-cache check → per-request CSP nonce →
// strict security headers → admin session + CSRF → render → authored redirects on a 404.
// (CLAUDE.md §8.) src/worker.ts backstops what Astro answers before this runs and what
// the ASSETS binding passes through (`ensureSecurityHeaders`); public/_headers covers the
// static files the asset worker serves without the Worker. The CSP's Report-Only switch is
// `CSP_REPORT_ONLY` in src/lib/http/securityHeaders.ts — one switch for all three.
//
// Redirect precedence (design-port R3-1, plan R3-d): live page > route-level code map
// (src/lib/services/retired.ts, services only) > the authored `redirects` table (KV
// snapshot, src/lib/http/redirects.ts) > 404. The table is consulted ONLY after the
// render answered 404, which is what makes the first two hold — an authored rule can
// never shadow a page that exists — and it removes a KV read from every request that
// renders. The 404 page itself is `private, no-store` (src/pages/404.astro) so a rule
// authored later is never hidden behind an edge-cached 404.

/** Tier C (CLAUDE.md §2): the admin and its API are never cached, anywhere. */
const PRIVATE_CACHE = 'private, no-store, max-age=0, must-revalidate';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The methods an authored redirect answers: a 30x on a POST would replay nothing useful. */
const REDIRECTABLE_METHODS = new Set(['GET', 'HEAD']);

/**
 * The only private paths reachable without a session: the three sign-in screens (sign
 * in, forgot password, reset password: Admin v2 F7) and the endpoints their forms post
 * to. All six still get the CSRF check and `no-store`; what they skip is the
 * authentication gate, which they obviously cannot satisfy.
 */
const LOGIN_PATH = '/admin/login';
const PRE_AUTH_PATHS: ReadonlySet<string> = new Set([
  LOGIN_PATH,
  '/admin/forgot',
  '/admin/reset',
  '/api/admin/auth/login',
  '/api/admin/auth/forgot',
  '/api/admin/auth/reset',
]);

/**
 * The path the pre-auth list is read with. `trailingSlash: 'ignore'` (astro.config.mjs)
 * routes `/api/admin/auth/login/` to the sign-in endpoint too, so the list, and the body
 * limit it brings, must not depend on the slash.
 */
function routeKey(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

/** A form post the CSRF check would read for its token: urlencoded, no token header. */
function tokenInBody(request: Request): boolean {
  if (request.headers.has(CSRF_HEADER_NAME)) return false;
  return (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
}

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
  // By the route Astro matched, not by spelling: `/_image/`, `/%5Fimage` and `/_imag%65/`
  // reach the same endpoint (src/lib/http/imageGuard.ts `isImageEndpoint`).
  const isImage = isImageEndpoint(context.routePattern, url.pathname);
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
    // withSecurityHeaders, not applySecurityHeaders: fetch()-derived responses (the
    // /_image endpoint, platform assets) carry immutable headers and must be rebuilt.
    out = withSecurityHeaders(out, {
      nonce,
      reportOnly: CSP_REPORT_ONLY,
      ...(extras ?? {}),
    });
    if (isPrivate) out.headers.set('Cache-Control', PRIVATE_CACHE);
    return out;
  };

  // 1) Maintenance pre-cache check (before edge-cache lookup). /admin, /api, /healthz and
  //    the image endpoint exempt. `/_image` is not a page: it answers only the transforms
  //    the guard below admits, and its stills are as public as the `/_astro/*` files the
  //    asset layer serves without the Worker during maintenance. Gating it 503'd the admin's
  //    own thumbnails of uploads for every editor off the allowlist.
  if (!isAdmin && !isApi && !isHealth && !isImage) {
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

  // 1b) Image transforms answer only the URLs our own markup emits. Every other
  //     combination of width, height and format would be a new "unique transformation"
  //     against the Images free-plan quota (src/lib/http/imageGuard.ts). The endpoint runs
  //     the same check itself (src/lib/http/imageEndpoint.ts); this one answers first.
  if (isImage && !checkImageRequest(url.searchParams).ok) {
    return secured(imageGuardResponse());
  }

  // 2) Admin: session resolution + CSRF. Everything below is Tier C.
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

    // Authentication gate. Authorization (which capability, which role) is the API
    // kernel's job — this only answers "is there a verified session at all".
    const route = routeKey(url.pathname);
    const preAuth = PRE_AUTH_PATHS.has(route);
    const unauthenticated = (): Response => {
      if (isAdminApi) return jsonError(401, 'unauthenticated');
      const next = `${url.pathname}${url.search}`;
      return context.redirect(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`, 302);
    };

    if (!SAFE_METHODS.has(request.method)) {
      if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
        return secured(jsonError(403, 'bad-origin'));
      }
      // Signed out, on a path that needs a session: the answer is already known, so it is
      // given before a byte of the body is read. The token check below clones a form body,
      // and until the F7 review a signed-out post of any size to any admin path was read
      // (the clone, and the original buffered behind it) before its 401.
      if (!ctx && !preAuth) return secured(unauthenticated());
      // Anyone can post to a pre-auth path, and its body is read several times below (the
      // token check's clone, a refused form's clone, the handler): bound it first, before
      // any of them (src/lib/auth/bodyLimit.ts). A sign-in form goes back to its page.
      if (preAuth && !(await bodyWithinLimit(request))) {
        return secured(tooLargeSignInForm(request, route) ?? jsonError(413, 'too-large'));
      }
      // Behind a session, the one body this middleware reads itself is a form's, for its
      // token: bounded too (what a handler reads is the handler's).
      if (
        !preAuth &&
        tokenInBody(request) &&
        !(await bodyWithinLimit(request, PRIVATE_FORM_BODY_LIMIT))
      ) {
        return secured(jsonError(413, 'too-large'));
      }
      const cookieToken = cookies.get(CSRF_COOKIE_NAME)?.value ?? null;
      if (!csrfTokenMatches(cookieToken, await submittedCsrf(request))) {
        // A sign-in screen's own form post (zero JS: the browser shows the answer) goes
        // back to its page with a fixed code, its handler never run, rather than to a
        // JSON page with no way out. Everything else keeps the JSON 403.
        const back = await expiredSignInForm(request, route);
        return secured(back ?? jsonError(403, 'csrf'));
      }
    }

    if (!ctx && !preAuth) return secured(unauthenticated());
  }

  // 3) Render.
  const rendered = await next();

  // 4) Authored redirects (301/302/308), only where the render answered 404 — see the
  //    precedence note in the header. Public paths only: the table is authored by the
  //    SEO role, and a rule over /admin, /api or /healthz could lock the CMS, break the
  //    admin's own API calls or silence the synthetic monitors; the map builder drops
  //    those sources too, so this exemption is belt-and-braces. The map read fails open.
  if (
    rendered.status === 404 &&
    !isAdmin &&
    !isApi &&
    !isHealth &&
    REDIRECTABLE_METHODS.has(request.method)
  ) {
    const rule = lookupRedirect(url.pathname, await getRedirectMap(env));
    if (rule) return secured(redirectResponse(rule, url));
  }

  // 5) Apply the same headers to the rendered response.
  return secured(rendered);
});
