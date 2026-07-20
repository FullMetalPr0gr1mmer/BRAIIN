# CLAUDE.md — Braiin Station Engineering Standard

> This file is the **single, authoritative engineering standard** for Braiin Station. If code and this document disagree, this document wins until amended in a reviewed PR.

---

## 1. Project Summary

**Braiin Station** is a production, single-platform creative-agency system with four parts:

1. **Public site** — bilingual EN/AR (RTL) marketing/portfolio site for **14 services**, fully CMS-driven sections (toggleable, re-orderable, styleable, per-section error isolation). Each service detail page opens with its **own hero video**; **Gaming** launches as a "coming soon" teaser.
2. **AI Style-Finder** — lead-gen quiz app. **Logic deferred**: ship the **module boundary + security/cost envelope only** (proxy, rate limits, spend cap, Zod wrappers around a `501` stub).
3. **Creative Knowledge blog** — SEO/GEO/AEO content engine.
4. **Admin / CMS** — authenticated, 4 roles: **Admin, Content Creator, SEO, Developer**. RBAC enforced **server-side from scratch**.

The 14 services: Branding · Animations · Motion Graphics · Videography · Photography · Montage · Event Planning · Advertising · Social Media · Web Development · SEO/GEO/AEO · Music · Merchandise · **Gaming (teaser)**.

---

## 2. Locked Decisions (confirmed 2026-06-10)

- **Build:** GREENFIELD / fresh. Every `[reuse]`-tagged feature is **built new**. RBAC from scratch.
- **Stack:** Astro + React admin (islands) + Supabase (Postgres, Auth, Edge Functions, Storage) + Tiptap. **TypeScript strict.** Zod for all content + form input.
- **Hosting/adapter:** **Cloudflare Workers Builds — not Pages** (the Astro Cloudflare adapter dropped Pages support) via the Astro Cloudflare adapter. Cloudflare WAF, Stream, image transforms/cache, MENA edge. On-demand `/admin`; static-first public shell.
- **Tenancy:** **SINGLE-TENANT at launch, TENANT-READY schema.** `tenant_id` + tenant-scoped RLS on **every** table from day 1.
- **i18n:** path-based `/` (EN) + `/ar/` (AR). hreflang + `x-default`, per-language self-referential canonicals, both languages in sitemap, complete AR metadata/OG.
- **Analytics canonical source:** **first-party self-hosted analytics is the single source of truth** (PDPL-friendly, consent-gated, no double-write). GA4 secondary, behind consent.
- **AI Style-Finder (deferred):** server-side proxy, per-IP/session rate limits + spend caps; default model = **latest Claude (Opus/Sonnet 4.x)**.
- **Search:** Postgres FTS in v1 with **explicit Arabic-tokenisation validation**; swap-ready behind one accessor.
- **Jurisdiction:** Saudi Arabia (`.sa`) — **PDPL applies**.

### Central tension (the load-bearing architecture)
Static, cacheable shell **+** Server Islands (`server:defer`) **+** on-demand `/admin` **+** on-demand revalidation / Live Content Collections (a published edit **never triggers a full rebuild**) **+** Content Layer API **+** tag-based edge cache invalidation tied to publish.

#### Render tiers
| Tier | What | Astro setting | Cache |
|---|---|---|---|
| **A — Static shell** | All indexable content (`/services/*`, `/portfolio/*`, `/creative-knowledge/*`, `/about/*`, `/ar/*` twins) | `output:'server'`, route opts in with `prerender = true` (implemented as long-`s-maxage` edge-cached SSR) | Edge-cached, purge-by-tag on publish |
| **B — Server Islands** | ONLY non-indexable dynamic holes | `server:defer` | Per-island `Cache-Control` + `cacheHint.tags` |
| **C — SSR Worker** | `/admin/**`, Style-Finder dynamic API | `prerender = false` | `private, no-store` |

**Indexable-content rule (hard):** indexable content lives in Tier A. Reviewers reject PRs that hydrate indexable content client-side. **Publish = cache event, not a rebuild.** Cache-Tag scheme `tenant:<tid>`, `route:<name>`, `<entity>:<slug>`, `<entity>:all`, `locale:<en|ar>` (≤30 tags/purge, ≤30k/24h). Adapter locks: `imageService:'cloudflare-binding'`, `sessionKVBindingName`/`imagesBindingName`. All DB access via the Supavisor transaction-mode pooler.

> **Amendment (KAN-31, Astro 7 / adapter 14):** `platformProxy.enabled` was removed from this lock set — the option no longer exists in `@astrojs/cloudflare` v14's `Options` (it is silently ignored). Worker bindings are now reached via `import { env } from 'cloudflare:workers'`; `Astro.locals.runtime.env` was removed in Astro 6 and its getter **throws**. Toolchain floor is now **Node ≥ 22.12** (Astro 7 hard-refuses Node 20). The other three adapter locks are unchanged.

---

## 3. THE FOUR PILLARS (hard requirements, in priority order)

**Absolute order: 1) Security 2) Performance 3) SEO/GEO/AEO 4) Scalability.** Higher pillar wins. **Never weaken authz/CSP/consent to hit a perf budget — file an exception.**

### Pillar 1 — Security
- [ ] Authorization in **two independent server layers that must both pass**: Postgres RLS (primary) + `assertCap()` (secondary). React `can()` is UX only.
- [ ] Every table: `tenant_id uuid not null`, RLS `ENABLE` + `FORCE`; every policy `USING`/`WITH CHECK` includes `tenant_id = (select auth.current_tenant_id())`.
- [ ] Role + `tenant_id` via the Custom Access Token Hook from `app_metadata` (never `user_metadata`). On role/tenant change, force-revoke sessions.
- [ ] Publish/archive/delete gated by RESTRICTIVE RLS, not hidden buttons.
- [ ] `leads.budget`/`timeline`/`internal_notes`/`ip_inet` restricted to **Admin + Developer** at the column level (column GRANT + `leads_safe` view omitting them + role-checked decrypt path as the gate of record); Content Creator and SEO get **no** lead access. `leads_safe`'s GRANT is **not** to all `authenticated`.
- [ ] Secrets via `astro:env` (`context:"server", access:"secret"`); service-role key, `ANTHROPIC_API_KEY`, signing keys, `LEAD_PII_ENC_KEY`, `AUDIT_HMAC_KEY` never `PUBLIC_*`/client-bundled.
- [ ] **Strict CSP with per-request nonce and NO `'unsafe-inline'`** (`style-src` nonce-based — theme = CSS custom properties, Tiptap class-based with `style=` stripped; `data:`/`blob:` dropped from `img-src` and the sanitizer). `frame-ancestors 'self'`; `connect-src 'self'` covers the same-origin RUM beacon + Sentry tunnel. HSTS preload, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP. Report-Only one cycle, then enforce. Don't call CSP "strict" while shipping `'unsafe-inline'` — it ships without it.
- [ ] Sessions in `httpOnly; Secure; SameSite=Lax` (`__Host-`) cookies; `getUser()` signature verification. CSRF: double-submit `__Host-csrf` or same-origin check on all mutations.
- [ ] Edge Functions verify JWT against JWKS. `postMessage` explicit `targetOrigin`, origin+source checked, Zod envelope, tokens as CSS custom properties only.
- [ ] Tiptap sanitised on write AND render; never `set:html` unsanitised. Every public form Zod-validated server-side. The **anon search endpoint is NOT captcha-gated** — edge rate-limit + Zod cap (≤64 chars, no control chars) + **`websearch_to_tsquery` (never raw `to_tsquery`)** + per-query `statement_timeout` + capped rows.
- [ ] **AI Style-Finder = server-side proxy, no exceptions** (even at the `501` stub): per-IP+session rate limit, daily USD spend cap in DO + alert, prompt-injection hardening, answer-hash cache — tested now.
- [ ] **Lead PII:** envelope-encrypt `phone`/`email`/`budget`; gate server-side; audit-log every view/export; retention purge. PDPL.
- [ ] `audit_log` append-only + HMAC-hash-chained by a **`BEFORE INSERT` trigger** (DB computes the hash on every path incl. service-role; callers cannot supply/skip/forge it). `AUDIT_HMAC_KEY` in **Supabase Vault**, readable only by the definer (not the `astro:env` store). Chain head **anchored hourly to object-locked R2**; hourly verifier **pages on mismatch**. No UPDATE/DELETE.
- [ ] `export-backup`/`export-csv`: in-function auth + role∈{Admin,Developer} + **live-recheck** of `profiles.role`/`is_active`/`locked_until` (demotion effective immediately) + rate-limit (3/hr/user AND tenant aggregate) + **two audit entries** (attempt + outcome with row count/status) + abnormal-volume alert + tenant-scoped + `no-store`. PII decrypted only for `leads.sensitive` holders.
- [ ] **Anon tenant fence:** anon `tenant_id` resolves **server-side** (server-set GUC / fixed anon-JWT claim), never client-chosen; public writes go through `submit-contact-form` which resolves the tenant server-side. pgTAP proves an anon insert/select with no claim resolves to the single tenant and cannot target another.
- [ ] **Maintenance mode + IP allowlist** is a **Worker-level pre-cache check** in `src/middleware.ts` (503 before edge-cache lookup; `/admin` exempt; flag+allowlist in `site_settings`/KV) — coexists with the long-`s-maxage` Tier-A cache without a purge.
- [ ] WAF/rate limits: `/api/search/suggest` 30/min/IP block; `/api/ai/style-finder` **60/hr/IP block** (NOT 10/60s); per-session 20/hr in the Worker before token spend; DO spend cap is the hard ceiling. WAF blocks the **full training-deny token set** (GPTBot/ClaudeBot/Google-Extended/CCBot/Applebot-Extended/Meta-ExternalAgent — same code-owned map as the robots.txt snapshot test), allows retrieval crawlers (OAI-SearchBot/Claude-SearchBot/PerplexityBot/Bingbot). `/notify-lead` WAF rate-limited.
- [ ] Login lockout: 5 failures / 15 min → `423` for 15 min; generic copy (no enumeration).
- [ ] Supply chain: pinned deps + lockfile + `npm ci`; Renovate; `npm audit` high + Socket/osv-scanner; Actions pinned to SHAs.

### Pillar 2 — Performance
Meet §6 budgets (CI-enforced; `/admin` exempt from CWV). INP source of truth = field RUM; CI uses TBT ≤200ms. Islands `client:visible`/`client:idle`. Astro `<Picture>` only (explicit width/height). Edge image transforms (`cacheKey` = full-size source URL). Self-hosted woff2, subset per script, `font-display:swap` + metric-overrides, preload only the hero face. Compositor-only animation; `content-visibility:auto`; reduced-motion disables; CSS-only marquee + field-INP probe. Video via Cloudflare Stream only; poster is the LCP `<img>`; `preload="none"`; `hls.js` post-LCP, excluded; zero video bytes before intersection (CI-asserted). Granular `Cache-Tag`; purge by tag only. RUM web-vitals beacon consent-gated, first-party only.

### Pillar 3 — SEO / GEO / AEO
Indexability hard rule; one `<head>` choke point (`<SeoHead>`/`<JsonLd>`). Per-language self-referential canonicals; reciprocal hreflang + `x-default`→EN; AR meta first-class (CI blocks empty `meta_*_ar`). Redirects module v1 (real 301/302/308). 8 JSON-LD types validated in CI (EN+AR). Three-tier code-owned AI-crawler policy (TRAINING incl. Meta-ExternalAgent → Disallow; RETRIEVAL → Allow; USER → Allow). Truthful `dateModified`. Sitemaps + `llms.txt` regenerate on publish. GEO authoring defaults (answer-first 40–60w; named stats; E-E-A-T author pages — no anonymous authorship). `seo-ci` blocking gate.

### Pillar 4 — Scalability
Supavisor transaction mode (`:6543`, `pgbouncer=true`, `prepare:false`); `:5432` for migrations + `pg_cron`. One analytics source; no double-write. Telemetry append-only via monthly range partitions; retention by dropping partitions. **Raw retention is the single named constant `RAW_TELEMETRY_RETENTION` = 90 days** (= `'3 months'`) for pageviews/CTA/search/service-interest — referenced identically here, in architecture §2.9/§8.3, and the delivery plan, never two hardcoded numbers; **pending PDPL legal sign-off (may go shorter, never longer)**. `web_vitals` 90d, `system_logs` 30d. Dashboards read `rollup_*` only; `audit_log` exempt. Every table `tenant_id` + RLS, tenant predicate first. No full rebuilds on publish. Media via Stream; `ref_count` GC. **Optimistic locking** (`version_token`, `WHERE version=$expected` → 409). Third-party calls: backoff + jitter + breaker + idempotency. AI provider: server-side proxy, spend cap, breaker-open → cached/rule-based.

---

## 4. THE 7-POINT DEFINITION OF DONE

> **No feature is "done" until ALL seven hold. Verbatim and non-negotiable.**

1. **Server-side authorized** — RLS + Edge/API `assertCap()`; never UI-only.
2. **Within performance budget** — meets §6; CI perf gates green.
3. **Server-rendered if indexable** — rankable/citable content in Tier A HTML.
4. **Accessible (WCAG 2.2 AA)** — axe zero violations on themed output; keyboard + RTL + reduced-motion.
5. **Tested** — unit + integration + e2e **+ per-role authz** (incl. `other_tenant`=deny).
6. **Observable** — errors → Sentry + `system_logs`; high-value/PII endpoints audit-logged; RUM beacons.
7. **Documented** — schema/loader/component documented; this CLAUDE.md amended if the standard changed.

---

## 5. ROLE × PERMISSION MATRIX

From `ROLE_CAPS` in `src/lib/authz/matrix.ts`. **Byte-for-byte identical to architecture.md §3.4, its `ROLE_CAPS` block, and the §9.3 authz test matrix; a CI snapshot test fails on any drift between the four.**

> **Canonical role model.** **Admin** = everything. **Content Creator** = authors content **and publishes/schedules** (no archive/delete, no leads, no settings). **SEO** = per-entity + global SEO meta/schema, redirects/canonical, integrations (GA4/Search Console/Calendly) + analytics; no content body, no leads. **Developer** = technical role: settings/identity/maintenance/theme, logs/audit/site-health, **leads management + PII + backup export** — but **NO content authoring, NO publish/schedule, NO archive/delete**. (Feature inventory: "Developer = full technical access + site-health panel.")

| Capability / Area | Admin | Content Creator | SEO | Developer |
|---|:---:|:---:|:---:|:---:|
| Users & roles | ✅ | ❌ | ❌ | ❌ |
| General settings (identity, footer, localization) | ✅ | ❌ | ❌ | ✅ |
| Integrations (GA4, Search Console, Calendly, reCAPTCHA) | ✅ | ❌ | ✅ | ❌ |
| Maintenance / hidden pages / page visibility | ✅ | ❌ | ❌ | ✅ |
| Theme editor | ✅ | ❌ | ❌ | ✅ |
| Services — create/edit | ✅ | ✅ | ❌ | ❌ |
| Blog — create/edit/autosave | ✅ | ✅ | ❌ | ❌ |
| Portfolio — create/edit | ✅ | ✅ | ❌ | ❌ |
| Pages & sections — edit/reorder/style | ✅ | ✅ | ❌ | ❌ |
| Navigation editor | ✅ | ✅ | ❌ | ❌ |
| Categories management | ✅ | ✅ | ❌ | ❌ |
| Publish / schedule | ✅ | ✅ | ❌ | ❌ |
| Archive / delete content | ✅ | ❌ | ❌ | ❌ |
| Per-entity SEO meta / slug / schema | ✅ | view | ✅ | ❌ |
| Global SEO defaults | ✅ | ❌ | ✅ | ❌ |
| Redirects / canonical module | ✅ | ❌ | ✅ | ❌ |
| Media — upload / edit metadata | ✅ | ✅ | meta only | ✅ |
| Media — hard delete | ✅ | ❌ | ❌ | ❌ |
| Leads — view list / manage status / notes | ✅ | ❌ | ❌ | ✅ |
| Leads — budget/timeline/internal_notes/ip (PII) | ✅ | ❌ | ❌ | ✅ |
| Leads / analytics — export CSV | ✅ | ❌ | ❌ | ✅ |
| Analytics — read dashboards | ✅ | ✅ | ✅ | ✅ |
| Search analytics | ✅ | ❌ | ✅ | ✅ |
| AI Style-Finder — questions/styles editor | ✅ | ✅ | ❌ | ❌ |
| AI Style-Finder — results/logic config | ✅ | ❌ | ❌ | ❌ |
| System logs — view | ✅ | ❌ | ❌ | ✅ |
| System logs — clear | ✅ | ❌ | ❌ | ❌ |
| Audit log — view | ✅ | ❌ | ❌ | ✅ |
| Site Health & Performance panel | ✅ | ❌ | ❌ | ✅ |
| Backup export (`export-backup`) | ✅ | ❌ | ❌ | ✅ |

Legend: ✅ full · "view"/"meta only" partial · ❌ none. `anon` and `other_tenant` get **deny on every row**. When in doubt, default-deny.

---

## 6. PERFORMANCE BUDGETS

Public routes only. **Failing any budget = blocked PR.** `/admin` exempt from CWV, gated on bundle size only.

| Metric | Budget | Notes |
|---|---|---|
| LCP | < 2.5s | poster frame is the hero LCP |
| INP | < 200ms | source of truth = field RUM |
| CLS | < 0.1 | explicit width/height; metric-override fonts |
| TBT (lab proxy) | ≤ 200ms | CI lab cap |
| Lighthouse Perf / A11y / SEO | ≥ 95 each | incl. an `/ar/` RTL route |
| Per-route client JS | ≤ 100 KB gzipped | `hls.js` post-LCP, excluded |
| EN+AR fonts per route | ≤ 180 KB woff2 | AR face counts |
| Hero face | ≤ 35 KB (Latin) / 45 KB (Arabic) | preload only this face |
| Poster image | ≤ 80 KB | Stream thumbnail |
| Media CLS contribution | 0 | |

CI gates: A `@lhci/cli` (minScore 0.95, numeric caps, unsized-images/modern-formats/font-display errors, `/ar/` route); B `size-limit`; C `budget.json`.

---

## 7. Security Non-Negotiables (summary)

- **Server-side authz on every read/write** — RLS + `assertCap()`; live-recheck on RLS-bypassing privileged endpoints.
- **Secrets never client-side** — `astro:env`; stored as Cloudflare **Worker Secrets**.
- **CSP/headers** — one enforcement point; per-request-nonce CSP with **no `'unsafe-inline'`** (nonce-based `style-src`, no `data:` images), `frame-ancestors 'self'`, `connect-src 'self'` (same-origin RUM + Sentry), HSTS preload. Report-Only one cycle, then enforce.
- **PII handling** — envelope-encrypt lead `phone`/`email`/`budget`; gate of record = role-checked decrypt path (Admin/Developer), with column GRANT + `leads_safe` view (omitting `internal_notes`/`ip_inet`, granted only to lead-viewing roles) as defense-in-depth.
- **Consent (PDPL)** — first-party store (`__Host-consent` + `consent_log`) and **one `hasConsent(category)` gate** (`packages/consent/gate.ts`) gating telemetry ingest, RUM beacon, GA4 injection, third-party video facade. Default denied; categories functional/analytics/marketing; cookie inventory + lawful basis + withdrawal/DSAR documented. (Full spec: architecture §4.12.)
- **Audit log** — append-only + HMAC-hash-chained by a `BEFORE INSERT` trigger (key in Vault, hourly R2 anchor, verifier pages on mismatch); no UPDATE/DELETE.
- **AI proxy** — server-side only; per-IP/session limits + spend cap + alert; binding around the `501` stub.
- **Export lockdown** — `export-backup`/`export-csv`: auth + role∈{Admin,Developer} + live-recheck + 3/hr/user + pre-dump audit + tenant scope + `no-store`.
- **Anon tenant fence + maintenance pre-cache check** — server-resolved tenant; Worker-level maintenance before cache lookup.
- **CSRF + sessions** — double-submit `__Host-csrf` or same-origin check; `getUser()` verification.

---

## 8. Conventions

### TypeScript & validation
`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. One Zod schema per shape in `packages/schemas`, imported by site, admin, Edge Functions. Zod is the single content boundary.

### Data model & schema
Every table: `id`, `tenant_id NOT NULL`, timestamps, `created_by`/`updated_by`; RLS `ENABLE`+`FORCE` on creation; `WITH CHECK (tenant_id = auth.current_tenant_id())`. Tenant + role from `app_metadata`; `updated_at` trigger-set. One lifecycle enum `content_status('draft','scheduled','published','archived')`; Gaming teaser = `published + is_teaser=true`, not a 5th status. Bilingual rule (scalar → `_ar`; rich-text/array → locale-keyed JSONB). Tiptap as sanitised JSON + derived sanitised-HTML cache. `audit_log` append-only; separate from `system_logs`. Leads PII (`budget`/`timeline`/`internal_notes`/`ip_inet`) gated to Admin/Developer.
- **FTS:** generated `search_en`/`search_ar` tsvector + GIN; Arabic normalise first (tashkeel/alef/ة/kashida) then `'arabic'`. AR-tokenisation CI gate has a **concrete pass bar** (≥30 curated pairs, normalization assertions, **recall@5 = 100% + zero zero-result curated queries**). Swap-trigger threshold defined. Unified cross-entity search = `UNION ALL` behind one `search_content` accessor; did-you-mean via `pg_trgm`. Query input uses `websearch_to_tsquery`.
- `citext` slugs/emails; slugs unique per `(tenant_id, slug)`; `redirects` + `portfolio_services` are v1.
- Versioning: a **single polymorphic `content_versions`** (+ `version_token`). **There is no `page_versions` table** — page history is a `content_versions` row.
- Admin entities in v1 schema: `team_members` (E-E-A-T authors; `blog_posts.author_id` → `team_members`), `certifications`, `statistics` (stat counters), `media_assets.folder`/`tags`. Dashboard banners (stale/scheduled-today/missing-images) are **derived views**, not a table.

### File / layout conventions
`src/middleware.ts` (security headers + redirects + maintenance pre-cache); `src/lib/authz/matrix.ts` (`ROLE_CAPS`, CI snapshot-asserted against both doc matrices); `packages/consent/gate.ts` (the single `hasConsent`); `packages/schemas`; `SeoHead`/`JsonLd`; `SectionRenderer`; `StreamPlayer`; `supabase/migrations/`; `live.config.ts`; `tests/authz/matrix.spec.ts`.

### Rendering & data flow
Content Layer loaders use the anon key under RLS (`status='published'`, tenant-scoped). Per-section error isolation mandatory. Both EN and AR built; both in sitemap.

### i18n / Commit-PR rules
Path-based `/` + `/ar/`; reciprocal hreflang + `x-default`→EN; AR meta/OG Zod-required. **CI gate order (pillar-priority):** typecheck/lint → schema-validation → authz → unit/integration → perf-budgets → seo-schema → a11y → visual-regression → supply-chain. Migrations forward-only, expand/contract. End commits with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; PR bodies with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## 9. Testing Requirements

> **No feature merges without its tests.**

- **Per-role authz (headline):** every sensitive op has a row over `admin, content_creator, seo, developer, anon, other_tenant`; `other_tenant` = deny on every row.
- **pgTAP RLS tests** per role/table; Edge `{role×capability}` 403/2xx matrix; exhaustiveness over `CAPS×roles`; cross-tenant zero-rows. `set_config` claim injection restricted to the pgTAP harness.
- **Targeted security regression tests (all blocking):** (a) anon tenant fence (no-claim insert/select resolves to the single tenant, cannot target another); (b) live-recheck (demote without refresh → export/lead/user-management endpoints 403 immediately); (c) lead PII (SEO/Content Creator zero access; `internal_notes`/`ip_inet`/`budget`/`timeline` unreachable for non-Admin/Developer; Developer `export-backup` audited with row counts); (d) notify-lead (unsigned POST → 401, no PII in body); (e) search safety (tsquery metacharacters + overlong input handled safely); (f) role-matrix snapshot (`ROLE_CAPS`, §3.4, §9.3, §5 byte-for-byte consistent); (g) AI limits (61st IP / 21st session call → zero upstream call); (h) audit chain (direct/service-role insert still chained; tamper detected against the R2 anchor).
- **Coverage:** 100% branch on authz + schema modules; global lines 80 / functions 80 / branches 75.
- **Negative E2E** proves server 403 (not just a hidden button) for every role-gated endpoint.
- **Unit + integration** for loaders/schemas/builders. Arabic FTS has explicit integration assertions with the **concrete pass bar** (recall@5 = 100%, zero zero-result curated queries) — blocking.
- **Playwright e2e** EN+AR; CI asserts zero video bytes before intersection.
- **Visual regression** over `page_sections` × {EN/AR RTL} × {light/dark}.
- **axe** WCAG 2.2 AA zero violations (blocking) + 4 targeted checks (neon-on-dark contrast, reduced-motion, captions, RTL).
- **JSON-LD** validated per entity type, EN+AR.

---

## 10. Observability, DR & Notifications

- **Errors** → Sentry (same-origin tunnel) + `system_logs`; `beforeSend` strips lead PII. Releases tagged with SHA.
- **RUM** web-vitals → `web_vitals` via `sendBeacon`, consent-gated, first-party only.
- **Synthetic monitors** (independent of Cloudflare, MENA) hit `/`, `/ar/`, `/healthz` every 60s; scripted contact-form journey every 15 min.
- **DR:** PITR (RPO ≤ 2 min, 28 days, RTO ≤ 1 hr) + off-platform `pg_dump` → separate-account encrypted R2 + nightly media mirror → object-locked R2 (also the audit-chain anchor). **Quarterly timed restore drill.**
- **Lead notifications** event-driven (trigger → `pg_net` → `notify-lead`), after commit. **The inbound trigger→Worker call is authenticated** — `Authorization: Bearer <NOTIFY_LEAD_SECRET>` from **Vault** (never `PUBLIC_*`), constant-time verified, `401` otherwise — and carries **only `lead_id`+`tenant_id`** (no PII over the public `*.workers.dev` hop); the Worker re-fetches the row server-side. `/notify-lead` is WAF rate-limited; a test asserts an unsigned POST → 401. Field gating via a **shared field-visibility helper** (budget/timeline/internal_notes omitted unless recipient holds `leads.sensitive`). The **outbound** generic-CRM webhook is HMAC-signed (`X-Braiin-Signature`).
- **Environments:** three isolated Supabase projects (preview/staging on `braiin-staging`, prod on `braiin-prod`).

---

## 11. When In Doubt

> **Flag and propose, rather than ship something that fails a pillar.**

If a task seems to require weakening Security, Performance, SEO, or Scalability — or you cannot satisfy all 7 DoD points — stop, write down the conflict, and propose options (including a documented exception with an owner and expiry). The pillar order (**Security > Performance > SEO > Scalability**) is the tie-breaker.