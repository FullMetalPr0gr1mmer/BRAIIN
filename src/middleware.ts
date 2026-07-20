import { defineMiddleware } from 'astro:middleware';
// Astro 6+ removed `Astro.locals.runtime.env` (the getter now throws). Worker bindings
// come from the runtime module instead — works in `astro dev` (workerd) and in prod.
import { env } from 'cloudflare:workers';
import { applySecurityHeaders, generateNonce } from '@/lib/http/securityHeaders';
import { getMaintenanceState, clientIp, maintenanceResponse } from '@/lib/http/maintenance';
import { lookupRedirect } from '@/lib/http/redirects';

// Single enforcement point for: maintenance pre-cache check → redirects →
// per-request CSP nonce → strict security headers. (CLAUDE.md §8.)
//
// CSP rollout: ship Report-Only for one cycle to collect violations, then flip to
// enforce. Toggle here (or wire to an env flag) — but it ALWAYS ships without
// 'unsafe-inline'.
const CSP_REPORT_ONLY = false;

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url, locals } = context;

  const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
  const isApi = url.pathname.startsWith('/api/');

  // The nonce is minted FIRST, before any early return. Previously it was generated
  // after the maintenance and redirect branches, which meant those two responses left
  // the middleware with no CSP, no HSTS and no nosniff at all — "one enforcement point"
  // held only for the path that reached the bottom of the function. A redirect is
  // exactly where a missing HSTS header matters most (that hop is the downgrade
  // opportunity), and a 503 is served precisely when things are already going wrong.
  const nonce = generateNonce();
  locals.cspNonce = nonce;
  locals.session = null;

  // `secured()` is the ONLY way a response leaves this middleware.
  const secured = (response: Response): Response => {
    applySecurityHeaders(response.headers, { nonce, reportOnly: CSP_REPORT_ONLY });
    return response;
  };

  // 1) Maintenance pre-cache check (before edge-cache lookup). /admin + /api exempt.
  if (!isAdmin && !isApi) {
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

  // 2) Redirects (301/302/308) — slug/canonical hygiene.
  const rule = await lookupRedirect(url.pathname, env);
  if (rule) return secured(context.redirect(rule.to, rule.status));

  // 3) Render, then apply the same headers to the rendered response.
  return secured(await next());
});
