---
paths:
  - 'src/middleware.ts'
  - 'src/components/**'
  - 'packages/schemas/**'
  - 'packages/consent/**'
  - 'supabase/functions/**'
---

# Front-of-house security (Pillar 1)

> Path-scoped reminder. **Canonical: `CLAUDE.md` §3 (Pillar 1), §7. CLAUDE.md wins.** Security is the highest pillar — never trade it for performance; file an exception (§11) instead.

- **CSP:** one enforcement point (`src/middleware.ts`), per-request **nonce**, **no `'unsafe-inline'`**. `style-src` nonce-based (theme = CSS custom properties; Tiptap class-based, `style=` stripped). No `data:`/`blob:` in `img-src`. `frame-ancestors 'self'`; `connect-src 'self'`. Don't call CSP "strict" while shipping `'unsafe-inline'`.
- **Secrets:** server-only via `astro:env` (`context:"server", access:"secret"`). Service-role key, `ANTHROPIC_API_KEY`, signing keys, `LEAD_PII_ENC_KEY`, `AUDIT_HMAC_KEY` are **never** `PUBLIC_*` or client-bundled — they live in Cloudflare Worker Secrets / Supabase Vault.
- **Zod is the single input boundary** (`packages/schemas`): every public form validated server-side. Tiptap sanitised on **write AND render**; never `set:html` unsanitised.
- **Consent (PDPL):** one `hasConsent(category)` gate (`packages/consent/gate.ts`), default denied; gates telemetry ingest, RUM beacon, GA4 injection, third-party video facade.
- **postMessage** (theme preview): explicit `targetOrigin`, origin + source checked, Zod envelope, tokens as CSS custom properties only.
- **AI Style-Finder:** server-side proxy even at the `501` stub — per-IP + session rate limit + daily USD spend cap + alert. No client-side model calls, ever.
- **CSRF + sessions:** double-submit `__Host-csrf` or same-origin check on every mutation; `httpOnly; Secure; SameSite=Lax` `__Host-` cookies; `getUser()` signature verification.
- Edge Functions verify JWT against JWKS + `assertCap()`. The anon search endpoint is **not** captcha-gated but uses `websearch_to_tsquery` (never raw `to_tsquery`) + Zod cap (≤64 chars, no control chars) + per-query `statement_timeout` + capped rows.
