import { defineMiddleware } from 'astro:middleware';
// Astro 6+ removed `Astro.locals.runtime.env` (the getter now throws). Worker bindings
// come from the runtime module instead — works in `astro dev` (workerd) and in prod.
import { env } from 'cloudflare:workers';
import { THEME_STYLESHEET_PATH, getActiveTheme } from '@/lib/data/theme';
import {
  CSP_REPORT_ONLY,
  collectInlineHashes,
  generateNonce,
  withSecurityHeaders,
} from '@/lib/http/securityHeaders';
import {
  getMaintenanceState,
  clientIp,
  maintenanceResponse,
  normalizeIp,
} from '@/lib/http/maintenance';
import { staffMayBypass } from '@/lib/http/maintenanceBypass';
import { maintenanceLogoSrc } from '@/lib/maintenance/logo';
import { getRedirectMap, lookupRedirect, redirectResponse } from '@/lib/http/redirects';
import {
  HIDDEN_CACHE_CONTROL,
  PASS,
  decide,
  getVisibilitySnapshot,
  type VisibilityGate,
} from '@/lib/http/visibility';
import { localizedPagePath, targetForRoute } from '@/lib/visibility/routes';
import { pageAccessCookieName, verifyAccessCookie } from '@/lib/visibility/access';
import { pageAccessGate } from '@/lib/visibility/gate';
import { withPageAccess } from '@/lib/visibility/scope';
import { handlePreview, previewConnectSources } from '@/lib/http/preview';
import { ga4Reads } from '@/lib/http/ga4';
import { getGa4MeasurementId } from '@/lib/data/ga4';
import { writeSystemLog } from '@/lib/data/systemLog';
import { LEAD_PII_ENC_KEY } from 'astro:env/server';
import { localeFromPath } from '@/lib/i18n';
import { checkImageRequest, imageGuardResponse, isImageEndpoint } from '@/lib/http/imageGuard';
import {
  isSameOrigin,
  csrfHeaderToken,
  csrfTokenMatches,
  generateCsrfToken,
  CSRF_COOKIE_NAME,
  CSRF_FIELD_NAME,
} from '@/lib/http/csrf';
import { createSessionClient, clearSessionCookies, HOST_COOKIE_BASE } from '@/lib/auth/session';
import { resolveAuthContext } from '@/lib/auth/context';
import { TWO_STEP_PATH } from '@/lib/auth/twoStep';
import { expiredSignInForm, tooLargeSignInForm } from '@/lib/auth/expiredForm';
import {
  PRIVATE_FORM_BODY_LIMIT,
  PUBLIC_API_BODY_LIMIT,
  bodyWithinLimit,
} from '@/lib/auth/bodyLimit';

// The PRIMARY enforcement point for: maintenance pre-cache check → page visibility →
// per-request CSP nonce → strict security headers → admin session + CSRF → render →
// authored redirects on a 404.
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

// Page visibility (Admin v2 U14a; src/lib/http/visibility.ts) runs right after the
// maintenance 503 and before anything renders: a hidden page answers a 302 to another page
// or the 404 page, `private, no-store` and `noindex`, before any database read and before
// any cache the Worker could consult; a link-only page renders as usual (Tier A: its content
// is public to anyone with the link) with `X-Robots-Tag: noindex`. It is keyed on the route
// Astro matched (src/lib/visibility/routes.ts), never on the path, for the reason the next
// paragraph gives. Every method is gated: a hidden page answers nothing. The snapshot is
// read through a one-minute isolate memo, so this costs about one KV read per isolate per
// minute, not one per request, and it fails open (decision D6, as maintenance does).
//
// A page BEHIND A PASSWORD (U14b) answers the gate below — a plain form, 403, `private,
// no-store`, noindex — unless the request carries a cookie this Worker signed for that page
// at that password version (src/lib/visibility/access.ts). With a valid cookie the page
// renders inside `withPageAccess`, which is how its sections are read at all: anon reads
// none of them (the RLS fence, 0061), so a gate that fails open still leaks nothing.

/**
 * A hidden page's answer, as it leaves: never stored by any cache, never indexed, and no
 * cache tag a purge could mistake for the page's.
 */
function hiddenAnswer(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set('Cache-Control', HIDDEN_CACHE_CONTROL);
  out.headers.delete('Cache-Tag');
  out.headers.set('X-Robots-Tag', 'noindex');
  return out;
}

/** Tier C (CLAUDE.md §2): the admin and its API are never cached, anywhere. */
const PRIVATE_CACHE = 'private, no-store, max-age=0, must-revalidate';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The methods an authored redirect answers: a 30x on a POST would replay nothing useful. */
const REDIRECTABLE_METHODS = new Set(['GET', 'HEAD']);

/**
 * The only private paths reachable without a session: the four sign-in screens (sign in,
 * forgot password, reset password: Admin v2 F7; accepting an invite: U12b) and the
 * endpoints their forms post to. All eight still get the CSRF check, the pre-auth body
 * limit and `no-store`; what they skip is the authentication gate, which they obviously
 * cannot satisfy.
 */
const LOGIN_PATH = '/admin/login';
const PRE_AUTH_PATHS: ReadonlySet<string> = new Set([
  LOGIN_PATH,
  '/admin/forgot',
  '/admin/reset',
  '/admin/invite',
  '/api/admin/auth/login',
  '/api/admin/auth/forgot',
  '/api/admin/auth/reset',
  '/api/admin/auth/invite',
]);

/**
 * What a session that passed the password but still owes its second step (Admin v2 U17,
 * src/lib/auth/context.ts) may reach: the two-step page and sign-out. Read like the pre-auth
 * list, by the path AND the route Astro matched. Everything else answers as if the request
 * had no session, but pointing at the second step: a page redirects to /admin/2fa, the API
 * answers 401 `two-step-required`. The pre-auth screens stay open to it (signing in as
 * someone else, a reset link). It also gets the CSRF check and `no-store`, as any session.
 */
const SECOND_STEP_PATHS: ReadonlySet<string> = new Set([TWO_STEP_PATH, '/api/admin/auth/logout']);

/**
 * The path the pre-auth list is read with. `trailingSlash: 'ignore'` (astro.config.mjs)
 * routes `/api/admin/auth/login/` to the sign-in endpoint too, so the list, and the body
 * limit it brings, must not depend on the slash.
 */
function routeKey(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

const isAdminPath = (path: string): boolean => path === '/admin' || path.startsWith('/admin/');
const isApiPath = (path: string): boolean => path.startsWith('/api/');
const isAdminApiPath = (path: string): boolean => path.startsWith('/api/admin/');

/**
 * Public write endpoints that bound their own bodies, so the middleware's public cap (H14)
 * leaves them to it: the Join form's multipart (Content-Length up to APPLY_BODY_MAX_BYTES,
 * 411/413 before a byte is read), the signed lead hook (readCapped) and the page password
 * form (PRE_AUTH_BODY_LIMIT). By the route Astro matched.
 */
const OWN_BODY_LIMIT_ROUTES: ReadonlySet<string> = new Set([
  '/api/apply',
  '/api/hooks/notify-lead',
  '/api/page-access',
]);
const isPreviewPath = (path: string): boolean =>
  path === '/admin/preview' || path.startsWith('/admin/preview/');

// What a request is (admin, API, private, pre-auth) is read from the path the middleware
// sees AND from the route Astro matched (F7, third review), because the two can differ.
// Astro 7.3.5's router matches the decoded path as it is (core/routing/match-request.js,
// called by the adapter before the render; when that finds nothing, FetchState matches it
// again with doubled slashes collapsed), while `url.pathname` has also been through the
// URL setter (core/fetch/fetch-state.js), which resolves dot segments and reads `\` as `/`.
// A dynamic segment takes `..\auth\login` whole, so `/api/admin/leads/..%5Cauth%5Clogin`
// runs the lead endpoint while `url.pathname` reads `/api/admin/auth/login`, a pre-auth path;
// `/api/admin/leads/..%5C..%5C..` reads `/`, not private at all; and
// `/admin/blog/..%5C..%5C..%5Cx` renders an editor's shell under `/x`. Nothing leaked (the
// API kernel refuses a request with no session client, and the pages load their data through
// it), but the session gate, the CSRF check and `no-store` were the kernel's to supply. So a
// request is private when either says so, and pre-auth only when both do; the route needs no
// slash rule (it is `/admin/login` with or without one). `routePattern` is set on every
// request Astro renders (the 404 page's own, `/404`, when nothing matched); a context without
// one (a test's) is read by its path alone, and is never pre-auth.

/**
 * A form post the CSRF check reads for its token: urlencoded, no token header. The one test
 * for both the bound on that read (below) and the read itself (`submittedCsrf`), so an empty
 * header cannot skip the one and still get the other (F7 review).
 */
function tokenInBody(request: Request): boolean {
  if (csrfHeaderToken(request) !== null) return false;
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
  const header = csrfHeaderToken(request);
  if (header !== null) return header;
  if (!tokenInBody(request)) return null;
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

  // The route Astro matched, beside the path (see "What a request is" above).
  const matched: string = context.routePattern ?? '';
  const isAdmin = isAdminPath(url.pathname) || isAdminPath(matched);
  const isApi = isApiPath(url.pathname) || isApiPath(matched);
  const isAdminApi = isAdminApiPath(url.pathname) || isAdminApiPath(matched);
  // /healthz must answer during maintenance. §10 has external synthetic monitors hitting
  // it every 60s; if it 503s the moment maintenance is switched on, planned maintenance
  // pages the on-call — training everyone to ignore the alert that matters.
  const isHealth = url.pathname === '/healthz';
  // By the route Astro matched, not by spelling: `/_image/`, `/%5Fimage` and `/_imag%65/`
  // reach the same endpoint (src/lib/http/imageGuard.ts `isImageEndpoint`).
  const isImage = isImageEndpoint(context.routePattern, url.pathname);
  // The site's theme stylesheet (Admin v2 E4), by the route Astro matched: custom properties
  // as public as global.css, which the asset layer serves during maintenance without the
  // Worker. The admin links it on every screen, and the admin works through maintenance.
  const isThemeSheet = matched === THEME_STYLESHEET_PATH;
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
  locals.secondStep = null;
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
  const secured = async (
    response: Response,
    extra: { noForms?: boolean; connectOnly?: readonly string[]; ga4?: boolean } = {},
  ): Promise<Response> => {
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
      // The page editor frames /admin/preview (Admin v2 R9): same-origin framing is admitted
      // on admin pages only, never on a public response.
      ...(isAdmin ? { frameSelf: true } : {}),
      ...(extra.noForms ? { noForms: true } : {}),
      ...(extra.connectOnly ? { connectOnly: extra.connectOnly } : {}),
      // GA4's hosts (Admin v2 U15) on an HTML page whose layout renders the loader, only.
      ...(extra.ga4 && isHtml ? { ga4: true } : {}),
    });
    if (isPrivate) out.headers.set('Cache-Control', PRIVATE_CACHE);
    if (isPrivate) {
      // Tier C is never indexed, and carries no cache tag a purge could mistake for a public
      // page's (a preview renders public pages, which set one: Admin v2 R9).
      out.headers.delete('Cache-Tag');
      out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    }
    return out;
  };

  // 1) Maintenance pre-cache check (before edge-cache lookup). /admin, /api, /healthz, the
  //    image endpoint and the theme stylesheet (E4) exempt. `/_image` is not a page: it
  //    answers only the transforms the guard below admits, and its stills are as public as
  //    the `/_astro/*` files the asset layer serves without the Worker during maintenance.
  //    Gating it 503'd the admin's own thumbnails of uploads for every editor off the
  //    allowlist; gating the theme would draw the admin in the brand's colours instead.
  //
  //    Admin v2 U9b: ONE KV read decides it (src/lib/http/maintenance.ts): in force when the
  //    switch is on and "Back on" has not come, so the site returns at that instant with no
  //    write. Then the IP allowlist (canonical addresses, compared as saved). Then, only when
  //    the value allows it, the staff bypass (src/lib/http/maintenanceBypass.ts): the admin's
  //    own session check, fail CLOSED (no session, an unreadable one, an error or a slow auth
  //    server: the 503). A bypassed page is private, untagged and noindex (step 5).
  let bypassed = false;
  if (!isAdmin && !isApi && !isHealth && !isImage && !isThemeSheet) {
    const now = Date.now();
    const m = await getMaintenanceState(env, now);
    if (m.active) {
      const ip = normalizeIp(clientIp(request) ?? '');
      const allowed = ip !== null && m.allowlist.includes(ip);
      if (!allowed) {
        // Fail closed twice over: the check answers false on any failure itself, and a throw
        // that escaped it would still be the 503, never a page.
        if (m.snapshot.staffBypass && (await staffMayBypass(cookies).catch(() => false))) {
          bypassed = true;
        } else {
          // The 503 page takes the nonce: its styles are in a nonced <style> block, because
          // the CSP it carries has no 'unsafe-inline'. Its language is the route's.
          const locale = localeFromPath(context.routePattern ?? url.pathname);
          return secured(
            maintenanceResponse(nonce, m.snapshot, locale, now, await maintenanceLogoSrc()),
          );
        }
      }
    }
  }

  // 1a) Page visibility, after the maintenance 503 and before the render (see the header).
  //     The snapshot rides `locals` to the menus, the sitemap and llms.txt, so the request
  //     reads it once.
  let gate: VisibilityGate = PASS;
  /** The page this request unlocked, when it did: the render runs inside its scope. */
  let unlocked: { pageId: string; tenantId: string } | null = null;
  if (!isAdmin && !isApi && !isHealth && !isImage && !isThemeSheet) {
    const snapshot = await getVisibilitySnapshot(env);
    locals.visibility = snapshot;
    const target = targetForRoute(context.routePattern);
    if (target) gate = decide(snapshot, target, Date.now());
    if (gate.action === 'password' && target?.kind === 'page') {
      // The route's language, as below: the route is what would render.
      const locale = localeFromPath(context.routePattern ?? url.pathname);
      const cookie = cookies.get(pageAccessCookieName(gate.id))?.value ?? null;
      const ok = await verifyAccessCookie(LEAD_PII_ENC_KEY, cookie, {
        pageId: gate.id,
        pv: gate.pv,
      });
      if (!ok) {
        // Nothing typed is echoed: `?pa=wrong` is the only thing the unlock route sends
        // back, and it says only that the last try was refused.
        return secured(
          pageAccessGate({
            nonce,
            locale,
            page: target.slug,
            next: localizedPagePath(target.slug, locale),
            note: gate.note,
            wrong: url.searchParams.get('pa') === 'wrong',
          }),
        );
      }
      unlocked = { pageId: gate.id, tenantId: snapshot.tenant ?? '' };
    }
    if (gate.action === 'hide') {
      // The route's language, not the path's: the route is what rendered.
      const locale = localeFromPath(context.routePattern ?? url.pathname);
      const answer = gate.to
        ? // 302, never 301: a hidden page comes back (decision D2).
          new Response(null, {
            status: 302,
            headers: { Location: localizedPagePath(gate.to, locale) },
          })
        : // A rewrite to the 404 page: it renders with its own status, and the middleware
          // does not run again for it.
          await next(locale === 'ar' ? '/ar/404' : '/404');
      return secured(hiddenAnswer(answer));
    }
  }

  // 1a') The active theme (Admin v2 E4): its read starts here, beside the page's own loaders,
  //      and BaseLayout awaits the same promise (src/lib/data/theme.ts, once per request), so
  //      the theme costs the page no round trip of its own. It never rejects (no theme is the
  //      brand's look). A preview (an /admin path) reads it inside its scope instead, and a
  //      route that is a file (the sitemap, robots.txt, llms.txt, the stylesheet itself, which
  //      reads it on its own) renders no layout, so nothing is started for it.
  const isFileRoute = /\.[a-z0-9]+$/i.test(matched);
  if (!isAdmin && !isApi && !isHealth && !isImage && !isFileRoute && request.method === 'GET') {
    void getActiveTheme(locals);
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

    const { ctx, revoke, pending = null } = await resolveAuthContext(supabase);
    // A stale, disabled or too-old session is torn down here rather than merely ignored:
    // signed out at the auth server (this session only, best effort: the refresh token in
    // the cookie stops working even if the cookie was copied), then its cookies cleared, so
    // the browser stops presenting a JWT that RLS would still honour (see auth/context.ts).
    if (revoke) {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      clearSessionCookies(cookies);
    }
    locals.session = ctx;
    locals.secondStep = pending;

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
    // Both the path and the route Astro matched must be one of the eight: a path that reads as
    // the sign-in endpoint but routes to a lead's is not pre-auth (see "What a request is").
    const preAuth = PRE_AUTH_PATHS.has(route) && PRE_AUTH_PATHS.has(matched);
    // The same rule for the second step's two paths (U17).
    const secondStepPath = SECOND_STEP_PATHS.has(route) && SECOND_STEP_PATHS.has(matched);
    const unauthenticated = (): Response => {
      if (isAdminApi) return jsonError(401, 'unauthenticated');
      const next = `${url.pathname}${url.search}`;
      return context.redirect(`${LOGIN_PATH}?next=${encodeURIComponent(next)}`, 302);
    };
    // A session still owing its second step, anywhere but the second step's own paths and
    // the pre-auth screens: no answer from the admin, only the way to the second step.
    const owesSecondStep = pending !== null && !secondStepPath && !preAuth;
    const toSecondStep = (): Response => {
      if (isAdminApi) return jsonError(401, 'two-step-required');
      const next = `${url.pathname}${url.search}`;
      return context.redirect(`${TWO_STEP_PATH}?next=${encodeURIComponent(next)}`, 302);
    };
    /** Who may go on: a full session; a pending one on its paths; anyone on a pre-auth one. */
    const admitted = ctx !== null || preAuth || (pending !== null && secondStepPath);

    if (!SAFE_METHODS.has(request.method)) {
      if (!isSameOrigin(request.headers.get('origin'), request.headers.get('host'))) {
        return secured(jsonError(403, 'bad-origin'));
      }
      // Signed out, on a path that needs a session: the answer is already known, so it is
      // given before a byte of the body is read. The token check below clones a form body,
      // and until the F7 review a signed-out post of any size to any admin path was read
      // (the clone, and the original buffered behind it) before its 401.
      if (owesSecondStep) return secured(toSecondStep());
      if (!admitted) return secured(unauthenticated());
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
        // The two-step page's own form goes back to it, as a sign-in screen's does.
        return secured(tooLargeSignInForm(request, route) ?? jsonError(413, 'too-large'));
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

    if (owesSecondStep) return secured(toSecondStep());
    if (!admitted) return secured(unauthenticated());
  }

  // 2) A public endpoint's body is bounded before any handler reads it (H14,
  //    src/lib/auth/bodyLimit.ts PUBLIC_API_BODY_LIMIT): the public JSON endpoints parse
  //    `request.json()` with no cap of their own. A write to /api/* outside /api/admin/ (the
  //    private branch above bounds what the middleware itself reads there) unless the route
  //    Astro matched keeps a limit of its own: by that route, so a path spelled like one of
  //    them but routed to another endpoint is still bounded.
  if (
    isApi &&
    !isAdminApi &&
    !SAFE_METHODS.has(request.method) &&
    !OWN_BODY_LIMIT_ROUTES.has(routeKey(matched)) &&
    !(await bodyWithinLimit(request, PUBLIC_API_BODY_LIMIT))
  ) {
    return secured(jsonError(413, 'too-large'));
  }

  // 2a) The releases preview (Admin v2 R9): a staff render of a public page with the pending
  //     changes laid over it (src/lib/http/preview.ts decides the door, the route and the
  //     scope). Behind the session gate above, so a request here has a session. By the path
  //     or the route Astro matched, as for every private request; the handler maps only the
  //     resolved path, and anything it does not know renders the preview's own 404 page.
  if (isAdmin && (isPreviewPath(url.pathname) || isPreviewPath(matched))) {
    const { response, rendered } = await handlePreview(
      { request, url, nonce, locals },
      {
        render: (path) => next(path),
        fallthrough: () => next(),
        snapshot: () => getVisibilitySnapshot(env),
        log: (entry) => writeSystemLog(entry),
      },
    );
    // A rendered preview sends no form and reaches no endpoint that writes (its CSP), on top
    // of the bridge; the preview's own 404 is an admin page and keeps the admin policy.
    return secured(
      response,
      rendered ? { noForms: true, connectOnly: previewConnectSources(url.origin) } : {},
    );
  }

  // 2b) Google Analytics 4 (Admin v2 U15, src/lib/http/ga4.ts): with the code-owned switch on,
  //     a public page route answered publicly reads the measurement id ONCE, started here so
  //     it overlaps the page's own reads, and the promise rides `locals` to the layout, which
  //     renders the same-origin loader for an id (src/components/Ga4Loader.astro). After the
  //     render the same answer decides the CSP (step 5), so a page lists Google's hosts
  //     exactly when it carries the loader. With the switch off (production until the owner
  //     signs off the notice) nothing is read and nothing changes. One subrequest of the
  //     Workers Free plan's 50 per page while on; none while off, and none on any other route.
  const ga4 = ga4Reads({
    method: request.method,
    routePattern: context.routePattern,
    internal: isAdmin || isApi || isHealth || isImage,
    private: unlocked !== null || bypassed,
  })
    ? getGa4MeasurementId()
    : null;
  if (ga4) locals.ga4 = ga4;

  // 3) Render. A page whose password this request answered renders inside the page-access
  //    scope, which is the only thing that lets its sections be read (src/lib/data/
  //    pageSections.ts reads them as the service role, for that one page).
  const rendered = unlocked === null ? await next() : await withPageAccess(unlocked, () => next());

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
    if (rule) {
      const redirected = await secured(redirectResponse(rule, url));
      // Seen past the maintenance page or a password (U9b): private like step 5's answer, so
      // the redirect a signed-in person sees is never cached for a visitor.
      return unlocked !== null || bypassed ? hiddenAnswer(redirected) : redirected;
    }
  }

  // 5) Apply the same headers to the rendered response (with GA4's hosts when step 2b's read
  //    found an id: the layout then carries the loader); a link-only page is not indexed,
  //    and an unlocked page is private: never stored by any cache, never indexed, and
  //    carrying no cache tag a purge could mistake for a public page's.
  const out = await secured(rendered, ga4 && (await ga4) ? { ga4: true } : {});
  if (gate.action === 'noindex') out.headers.set('X-Robots-Tag', 'noindex');
  if (unlocked !== null || bypassed) {
    // A page unlocked by its password, or one a signed-in person sees past the maintenance
    // page (U9b): private, never cached, never indexed, no tag a purge could mistake.
    out.headers.set('Cache-Control', HIDDEN_CACHE_CONTROL);
    out.headers.delete('Cache-Tag');
    out.headers.set('X-Robots-Tag', 'noindex');
  }
  return out;
});
