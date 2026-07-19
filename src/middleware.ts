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

  // 1) Maintenance pre-cache check (before edge-cache lookup). /admin + /api exempt.
  if (!isAdmin && !isApi) {
    const m = await getMaintenanceState(env);
    if (m.active) {
      const ip = clientIp(request);
      const allowed = ip !== null && m.allowlist.includes(ip);
      if (!allowed) return maintenanceResponse();
    }
  }

  // 2) Redirects (301/302/308) — slug/canonical hygiene.
  const rule = await lookupRedirect(url.pathname, env);
  if (rule) return context.redirect(rule.to, rule.status);

  // 3) Per-request CSP nonce + default (anonymous) session. Auth resolution lands
  //    in Phase 3; public requests are anonymous.
  locals.cspNonce = generateNonce();
  locals.session = null;

  const response = await next();

  // 4) Strict security headers on every response.
  applySecurityHeaders(response.headers, { nonce: locals.cspNonce, reportOnly: CSP_REPORT_ONLY });
  return response;
});
