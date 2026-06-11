# Braiin Station — Delivery Plan

> **Status:** Phased delivery plan, locked-decisions baseline of **2026-06-10**.
> **Build mode:** GREENFIELD / fresh. Every `[reuse]`-tagged module is built **new**; "reuse" describes the proven *pattern*, not portable code. RBAC enforced server-side from scratch.
> **Source docs:** `braiin-station-feature-inventory.md`, `braiin-station-analysis.md` (§11 = 13-item unblock list; §5–§10 = hard requirements).

---

## How to read this plan

### The four pillars (non-negotiable priority order)
1. **Security** — RLS-first authorization, secrets server-only by construction, PII protected.
2. **Performance** — CWV budgets that fail CI, edge-cached static shell.
3. **SEO / GEO / AEO** — all indexable content server-rendered HTML, validated schema.
4. **Scalability** — tenant-ready schema, pooled DB, publish-as-cache-event.

When two requirements conflict, the **higher pillar wins**. CI gate order mirrors this: authz → Lighthouse perf → JSON-LD + axe a11y → supply-chain. **A PR fails on the highest-priority pillar first.**

### Definition of Done (DoD) — all 7, every feature
1. **Server-side authorized** — RLS + Edge/API role guard; UI gating is UX-only.
2. **Within performance budget** — Gate A (Lighthouse), Gate B (size-limit), Gate C (budget.json).
3. **Server-rendered if indexable** — Tier-A HTML, never client-only.
4. **Accessible** — WCAG 2.2 AA; zero axe violations; neon-on-dark/reduced-motion/captions/RTL checks.
5. **Tested** — per-role authz matrix `{admin, content_creator, seo, developer, anon, other_tenant}` with `other_tenant=deny` on every row.
6. **Observable** — first-party RUM, error monitoring, audit/system logs, health-panel signals.
7. **Documented** — schema, role caps, runbook, operator notes.

### Gate before every phase
> **Each phase requires the client's explicit go-ahead before implementation begins.** This document is the plan of record; it is not authorization to build.

### Section-11 unblock list — closure tracker

| # | Unblock item | Closed in |
|---|---|---|
| 1 | Confirm the stack | Phase 0 |
| 2 | Rendering model | Phase 0 |
| 3 | RBAC server-side, not UI-only | Phase 0 (schema/RLS) → Phase 3 (full enforcement + tests) |
| 4 | Video pipeline | Phase 1 |
| 5 | CWV budgets in CI | Phase 0 |
| 6 | Redirects/canonical module in v1 | Phase 0 → Phase 2 |
| 7 | i18n URL strategy + hreflang | Phase 0 → Phase 2 |
| 8 | AI-crawler robots.txt + llms.txt | Phase 2 (+ WAF backstop in Phase 0) |
| 9 | Consent management + legal pages | Phase 0 — *closed only when the §4.12 consent store + single `hasConsent()` gate + the four gated call sites (telemetry ingest, RUM beacon, GA4 injection, video facade) are built and tested. Until then #9 is **NOT closed.*** |
| 10 | Analytics canonical source + retention/rollup | Phase 0 → Phase 3 |
| 11 | Connection pooling | Phase 0 |
| 12 | Single- vs multi-tenant | Phase 0 |
| 13 | Deferred AI Style-Finder spec | Phase 4 |

### Promoted to v1 vs legitimately deferred
**Promoted to v1:** redirects/canonical; consent store + single `hasConsent()` gate; server-side RBAC; video pipeline; CWV budgets failing CI; the shared resilience helper; optimistic locking; did-you-mean search.
**Deferred:** full AI Style-Finder logic (envelope binding now); full Gaming line (teaser ships); dedicated search engine (FTS v1); GA4 (secondary, consent-gated).

---

## Phase 0 — Foundation

> **Client go-ahead required.**

### Goal
Stand up the production substrate so every later feature is born secure, fast, indexable, tenant-ready. Closes the majority of §11 and bakes the pillars into infrastructure.

### In scope (highlights)
- Monorepo; three isolated Supabase projects; **Cloudflare Workers Builds (NOT Pages)**; supply-chain gates.
- Secrets server-only via `astro:env`; stored as **Worker Secrets**.
- Adapter locked (`imageService:'cloudflare-binding'`, `platformProxy`, KV sessions). Three-tier render model scaffolded: **Tier A = cache-backed SSR** (long-`s-maxage` + purge-on-publish — "prerendered/static" means edge-cached SSR refreshed on publish, not deploy-frozen). **Verify the Astro 6 cache layer / tag-purge→re-render path in staging before launch (launch-blocking).**
- **Single security middleware:** strict CSP with per-request nonce and **no `'unsafe-inline'`** (`data:`/`blob:` dropped from `img-src` and the sanitizer; RUM beacon + Sentry tunnel same-origin so `connect-src 'self'` covers them); Report-Only then enforce.
- **Maintenance mode + IP allowlist** as a **Worker-level pre-cache check** (503 before cache lookup; `/admin` exempt; `site_settings`/KV) — no purge needed.
- **WAF AI-crawler policy** blocks the full training-deny set (incl. **Meta-ExternalAgent**, same code-owned map as robots.txt). **AI rate-limit rule = 60/hr/IP block** (NOT 10/60s); search 30/min/IP block.
- **Migration 0001:** every table `tenant_id NOT NULL FK + indexed`, `RLS ENABLE+FORCE`, one seeded tenant; `app_role` enum + Custom Access Token Hook; core content tables, `media_assets` (incl. `folder`/`tags`), `team_members`, `certifications`, `statistics`, `partner_logos`, `leads`, `redirects`, `custom_themes`, `site_settings`, **`content_versions` (single polymorphic — `page_versions` is NOT used)** + `version_token`, `audit_log`, `system_logs`, telemetry tables, `consent_log`, `notification_log`. **Plus `login_attempts(email, ip, attempted_at, succeeded)` + `profiles.failed_login_count`/`locked_until`** so the lockout control has its schema home from day one (enforcement UI in Phase 3; invite/reset token lifetimes are GoTrue config).
- `content_status` enum; Gaming teaser = `published + is_teaser=true`. Hybrid bilingual storage. FTS scaffold. Supavisor `:6543`.
- **`audit_log` tamper-PROOF hardening (launch-blocking):** HMAC hash computed by a `BEFORE INSERT` trigger owned by a dedicated role (even service-role chained by the DB); `AUDIT_HMAC_KEY` in **Vault** (definer-only); chain head **anchored hourly to object-locked R2**; hourly verifier **pages on mismatch**.
- **Optimistic locking ships with the first editable surface** (Phase 0 scaffold, used from Phase 1). **Shared third-party resilience helper (§8.8) provisioned in Phase 0 infra** (consumers: Search Console pings in Phase 2, AI provider in Phase 4).
- Telemetry partitioning + retention by DROP PARTITION (single `RAW_TELEMETRY_RETENTION` = 90 days from `site_settings`, pending PDPL sign-off); nightly rollups.
- Design tokens; i18n + RTL scaffolding; redirects/canonical module.
- **Consent management + legal (built against §4.12 spec):** first-party store (`__Host-consent` + `consent_log`), server-readable signal, the single `hasConsent(category)` gate (`packages/consent/gate.ts`); granular categories (functional/analytics/marketing, default denied); gate wired at its four call sites; Privacy/Terms/Cookie pages; cookie inventory + lawful basis + withdrawal/DSAR. **#9 closed only when the store + gate + four call sites are tested.**
- Observability baseline (RUM beacon consent-gated, first-party only). DR baseline (PITR + off-platform `pg_dump` + media mirror).

### Exit criteria (DoD-tied)
1. Migration 0001 applied; CI fails any RLS-disabled public table; helpers proven; cross-tenant zero-rows green; single `ROLE_CAPS` matrix declared.
2. Three CI status checks red-on-violation (Gates A/B/C).
3. Tier-A path verified; client-only fetch lint-banned; `<SeoHead>` stubbed.
4. axe gate wired; neon-on-dark/reduced-motion/RTL scaffolded.
5. pgTAP authz harness; `other_tenant=deny` matrix; 100% branch on authz/schema.
6. RUM beacon flowing **only when `analytics` consent granted** (§4.12 gate wired); error monitoring (operational/legitimate-interest, PII-scrubbed); `audit_log` hash-chained by the trigger with the Vault key + R2 anchor + paging verifier; PITR + off-platform `pg_dump` verified by one timed restore drill.
7. env/secrets map (Worker Secrets, not Pages), render-tier policy, schema + RLS reference, the single `ROLE_CAPS` matrix, `RAW_TELEMETRY_RETENTION` value, redirects + consent runbooks committed.

### §11 closed
**1, 2** (rendering — *Tier-A freshness verified in staging before launch*), **3** (schema/RLS + `login_attempts`/lockout), **5, 6, 7, 9** (*only when §4.12 store + gate + four call sites built/tested*), **10** (single `RAW_TELEMETRY_RETENTION`), **11, 12**. Item **8** WAF backstop (full training-deny set incl. Meta-ExternalAgent) staged here.

---

## Phase 1 — Public Site

> **Client go-ahead required.**

### In scope (highlights)
- CMS section engine + per-section error isolation; Content Layer loaders (anon key, RLS, status-filtered); publish flips status + purges by Cache-Tag.
- Services index/detail with **Cloudflare Stream hero-video pipeline** (poster-as-LCP, `preload='none'`, tus upload, encode-ready webhook).
- Portfolio; Home (CSS-only marquee + INP probe); edge image transforms; self-hosted subset fonts.
- **Search v1:** unified cross-entity Postgres FTS as a **`UNION ALL` behind one `search_content` accessor** (shape pinned in architecture §2.8a — not an open risk); type tabs/sort/date/autocomplete; **did-you-mean via `pg_trgm`** (build item); **Arabic-tokenisation CI fixture with a concrete pass bar** (≥30 curated pairs, normalization assertions, **recall@5 = 100% + zero zero-result curated queries**), swap-trigger threshold documented; **anon search safety — no captcha, edge rate-limit + Zod cap + `websearch_to_tsquery` + statement_timeout**.
- Contact form (Zod server-side; public-write path is the `submit-contact-form` Edge Function resolving `tenant_id` server-side — anon never chooses the tenant); 404; **maintenance mode + IP allowlist enforced at the Worker pre-cache layer**; page-view/CTA tracking gated by `hasConsent('analytics')`.

### Exit criteria
Authorized (anon key under RLS; drafts unreachable; contact-form Zod). Performance (Gates A/B/C; poster is LCP). SSR-if-indexable (zero client-only fetches on indexable routes). Accessible (captions/controls; reduced-motion; RTL). Tested (section error-isolation; Arabic fixture green; EN+AR smoke). Observable (beacons; `media_egress_daily`; publish→purge traced). Documented.

### §11 closed: **4**.

---

## Phase 2 — Creative Knowledge (Blog) + SEO/GEO/AEO

> **Client go-ahead required.**

### In scope (highlights)
- Article system (TOC, key-takeaways, FAQ, **E-E-A-T author box sourced from `team_members`**, related posts); AR meta/OG Zod-required; Tiptap sanitised write+render.
- **Eight Zod-validated JSON-LD builders** + blocking CI schema-validation gate (EN+AR).
- **Three-tier robots.txt** (training incl. Google-Extended/CCBot/Applebot-Extended/Meta-ExternalAgent → Disallow; retrieval → Allow; user → Allow), code-owned + snapshot-tested; `llms.txt` auto-generated from the sitemap query.
- **Sitemaps** dynamic, per-type, both languages, truthful `lastmod`, regenerated + tag-purged on publish. **Search Console / sitemap pings go through the shared Phase-0 resilience helper** (first concrete consumer; off the publish critical path).
- i18n SEO finalisation; redirects/canonical surface; GEO answer-first constraints + 90-day freshness.

### Exit criteria
Authorized (article CRUD by `ROLE_CAPS` — Content Creator write, SEO meta-only, publish gated). Performance/SSR/Accessible/Tested (JSON-LD gate green EN+AR; robots snapshot; llms/sitemap drift; sanitiser tests). Observable. Documented.

### §11 closed: **8**; completes **6, 7**.

---

## Phase 3 — Admin / CMS

> **Client go-ahead required.**

### In scope (highlights)
- **Full server-side RBAC**: RLS primary + Edge guard second layer; RESTRICTIVE publish (Admin+Content Creator) / archive+delete (Admin-only); CSRF/same-origin; role/tenant change revokes sessions. **The single `ROLE_CAPS` matrix is byte-for-byte identical to architecture §3.4, the §9.3 matrix, and CLAUDE.md §5 — a CI snapshot test fails on drift.** Canonical model: Admin all; Content Creator author + publish (no delete/archive/leads); SEO meta/redirects/integrations/analytics (no content/leads); **Developer technical role — settings/theme/maintenance + logs/audit/site-health + leads & PII + backup export, NO content authoring/publish/archive/delete.**
- **Live-recheck on RLS-bypassing privileged endpoints** (`export-backup`/`export-csv`/`lead-detail`/`manage-users`).
- **Per-role pgTAP + Edge + Playwright authz tests block merge**, plus the **anon tenant-fence test** (no-claim insert/select resolves to the single tenant, cannot target another).
- Account lockout (using `login_attempts` + `profiles.locked_until` from Phase 0; 5/15min → 423, generic copy); invite/reset.
- Content CRUD for all collections incl. **`team_members`, `certifications`, `statistics`**; single polymorphic `content_versions` + `version_token` 409-on-conflict. Media library with **folders (`media_assets.folder`) + tags**. **Dashboard notification banners are derived views** (stale/scheduled-today/missing-images), not a table.
- **Leads + notifications:** lead access **Admin + Developer only**; PII via decrypt-path gate of record + column GRANT + `leads_safe` (omits `internal_notes`/`ip_inet`, not granted to all `authenticated`); pgTAP asserts SEO/Content Creator zero access. **Authenticated `notify-lead`** (`Bearer <NOTIFY_LEAD_SECRET>` from Vault, constant-time verified, 401 otherwise; carries only `lead_id`+`tenant_id`; Worker re-fetches; WAF rate-limited; shared field-visibility helper).
- Analytics (rollups only). Hardened postMessage theme editor. **Audit log hash-chained by `BEFORE INSERT` trigger** (Vault key, hourly R2 anchor, paging verifier). Site-health panel. Exports lockdown (live-recheck + 3/hr/user + tenant aggregate + attempt+outcome audit).

### Exit criteria
1. Authorized — RLS + Edge proven; RESTRICTIVE policies verified; role/tenant change revokes sessions **and** privileged endpoints live-recheck; leads sensitive columns unreadable by Content Creator/SEO; anon tenant-fence test green; `notify-lead` rejects unsigned POSTs 401; exports auth+live-recheck+per-user&tenant-rate-limited+audited (attempt+outcome).
2–7. `/admin` excluded from CWV (bundle-size gate only); non-indexable; WCAG 2.2 AA; the headline per-role authz suite + optimistic-lock 409 + notification field-gating tests block merge; audit chain verified; documented.

### §11 closed: **3** (fully), **10** (dashboards/rollups, no double-write).

---

## Phase 4 — AI Style-Finder (module boundary + deferred spec hand-off)

> **Client go-ahead required.**

### In scope (highlights)
- Isolated module returning `501` behind a fully tested security/cost wrapper.
- Server-side proxy (key server-only); per-IP/session rate limits + KV/DO daily spend cap + alert; prompt-injection hardening; answer-hash cache.
- Wrapped in the **shared Phase-0 resilience helper** (the AI provider is its Phase-4 consumer); breaker-open → cached/rule-based.
- **WAF numbers match the spend model:** 60/hr/IP at the edge (block), per-session 20/hr in the Worker before token spend, DO daily USD cap as the hard ceiling. Test: 61st IP / 21st session call refused with **zero upstream Anthropic call**.
- Default model = latest Claude (Opus/Sonnet 4.x). Deferred reasoning spec handed off.

### Exit criteria
Authorized (key absent from bundle; limits + cap server-side). Performance (no measurable public-route cost). SSR (non-indexable Tier-C / `noindex`). Accessible. Tested (rate-limit, spend-cap, breaker, prompt-injection, cache; per-role management tests). Observable. Documented (spec delivered; envelope binding on the future build).

### §11 closed: **13**.

---

## Cross-phase invariants
- **Client go-ahead gates every phase.**
- **CI gate order = pillar order:** authz → perf → JSON-LD + a11y → supply-chain.
- **Tenant-ready from migration 0001** (`other_tenant=deny` proves it).
- **Publish is a cache event, never a rebuild.**
- **First-party analytics is the single canonical source** (gated by the one `hasConsent('analytics')` function; no GA4 double-write).
- **One authoritative role matrix:** `ROLE_CAPS` byte-for-byte identical across architecture §3.4, §9.3, CLAUDE.md §5 (CI snapshot test). Developer is a technical role (no content authoring/publishing); publish is Admin + Content Creator; lead PII is Admin + Developer.
- **Secrets are server-only by construction** (`astro:env`; stored as Cloudflare **Worker Secrets**).
- **Forward-only, expand/contract migrations;** DR on PITR + off-platform `pg_dump`, with timed quarterly restore drills.

---

## Promotion / deferral summary (at a glance)

| Item | Status | Rationale | Lands in |
|---|---|---|---|
| Redirects / canonical | **Promoted to v1** | Slugs change day one | Phase 0 + 2 |
| Consent + legal pages | **Promoted to v1** | PII + tracking in a PDPL jurisdiction | Phase 0 |
| Consent store + single `hasConsent()` gate | **Promoted to v1** | #9 not closed until built + 4 call sites tested | Phase 0 |
| Server-side RBAC | **Promoted to v1** | UI gating is not security | Phase 0 → 3 |
| Video pipeline | **Promoted to v1** | #1 perf risk; 14 hero videos | Phase 1 |
| CWV budgets failing CI | **Promoted to v1** | "Fast" must be falsifiable | Phase 0 |
| Shared resilience helper (§8.8) | **Promoted to v1** (foundational) | Search Console (P2), AI (P4) consume it | Phase 0 → 2 → 4 |
| Optimistic locking (`version_token`) | **Promoted to v1** | Ships with the first editable surface | Phase 0 → used Phase 1+ |
| Did-you-mean / suggestions (search) | **In v1** | `pg_trgm` on zero/low-result queries | Phase 1 |
| Full AI Style-Finder logic | **Deferred** (envelope binding now) | Reasoning needs its own spec | Phase 4 + later build |
| Full Gaming service line | **Deferred** (teaser ships) | Published `is_teaser=true`, indexable | Phase 1 |
| Dedicated search engine | **Deferred** (FTS ships) | Postgres FTS v1, swap-ready accessor | Phase 1 |
| GA4 | **Secondary / optional** | Consent-gated, no double-write | Phase 0/3 |