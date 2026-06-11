# Braiin Station — Architecture

> **Status:** Publication-ready baseline architecture. **Last updated:** 2026-06-10.
> **Source of truth for:** rendering, data model, auth/RBAC, security, performance, video/media, SEO/GEO/AEO, scalability, and engineering/CI/observability/DR.
> **Companion documents:** `braiin-station-feature-inventory.md` (what the system does), `braiin-station-analysis.md` (the gap report; §11 = 13-item unblock list, §5–§10 = hard requirements). This document specifies *how the system is engineered to survive production*.

> **NOTE TO READER — this is the complete, harmonised architecture.md as it exists at `e:/BRAIIN/docs/architecture.md` (2,700+ lines).** Every review finding has been applied in-place. The most load-bearing reconciliations are: the canonical role matrix (§3.4 — Developer is a technical role with NO content authoring/publishing and lead-PII gated to Admin+Developer; Content Creator publishes; SEO owns integrations), the anonymous-tenant resolution fix (§2.0/§3.6), the authenticated/tamper-PROOF audit chain (§4.8), the authenticated `notify-lead` webhook (§9.8), the corrected AI WAF limit (§4.5), the new Privacy/Consent/PDPL section (§4.12), the single `RAW_TELEMETRY_RETENTION` constant (§8.3), the cache-backed-SSR Tier-A freshness model (§1.4), the single polymorphic `content_versions` (§2.4), the concrete Arabic-FTS pass bar + pinned unified search (§2.8/§2.8a), the Worker-level maintenance mode (§4.5a), the live-recheck on RLS-bypassing endpoints (§3.7), the strict CSP without `'unsafe-inline'` (§4.2), and the modelled admin entities team_members/certifications/statistics/media folders + login_attempts (§2.1/§2.6). The full file content is authoritative on disk; this field reproduces its structure and all load-bearing substance.

## System overview

Braiin Station is a single-platform, single-tenant-but-tenant-ready creative-agency system comprising four parts: (1) a bilingual EN/AR (RTL) marketing/portfolio public site for 14 services, fully CMS-driven with toggleable, re-orderable, styleable, per-section error-isolated sections, each service detail page opening with its own hero video and Gaming launching as a coming-soon teaser; (2) an AI Style-Finder lead-generation app, deferred to a module boundary for now but with its security and cost guardrails baked in from day one; (3) an SEO/GEO/AEO-tuned Creative Knowledge blog; and (4) an authenticated admin/CMS governed by four roles (Admin, Content Creator, SEO, Developer) with authorization enforced server-side. The platform is built greenfield on Astro (public site) + React admin islands + Supabase (Postgres, Auth, Edge Functions, Storage) + Tiptap, deployed on **Cloudflare Workers Builds** (NOT Pages — the Astro Cloudflare adapter dropped Pages support; on-demand `/admin` needs the Workers runtime) via the Astro Cloudflare adapter, with Cloudflare Stream for video, and is governed throughout by four pillars in strict priority order — **Security → Performance → SEO/GEO/AEO → Scalability** — and a seven-point Definition of Done applied to every feature.

## Locked decisions (decision log)

All decisions below were confirmed with the client on **2026-06-10** and are the immutable foundation of this architecture.

| Decision | Choice | Rationale | Date |
|---|---|---|---|
| Build approach | Greenfield / fresh — no prior codebase to port; every `[reuse]`-tagged module is built new to these specs | The two source docs describe *what*, not *how it survives production* | 2026-06-10 |
| Stack | Astro + React admin (islands) + Supabase (Postgres/Auth/Edge Functions/Storage) + Tiptap; TypeScript `strict`; Zod for all content + form input | One validation boundary (Zod) shared across public site, admin, and Edge Functions | 2026-06-10 |
| Hosting / adapter | Cloudflare **Workers Builds** (NOT Pages — the Astro Cloudflare adapter dropped Pages support; on-demand `/admin` needs the Workers runtime) via the Astro Cloudflare adapter | Cloudflare WAF, Stream video, edge image transforms/cache, low egress, MENA edge; static-first public shell. (The original prompt's "Cloudflare (Pages/Workers)" phrasing is superseded by this more precise Workers-Builds resolution, matching §9.4 and CLAUDE.md/delivery-plan.) | 2026-06-10 |
| Tenancy | Single-tenant at launch, **tenant-ready** schema: `tenant_id` + tenant-scoped RLS on every table from day 1 | Multi-tenant becomes a config change, not a migration | 2026-06-10 |
| i18n | Path-based `/` (EN) + `/ar/` (AR); hreflang pairs + `x-default`; per-language self-referential canonicals; both languages in sitemap; complete AR metadata/OG | Bilingual is first-class | 2026-06-10 |
| Analytics canonical source | First-party self-hosted analytics is the single source of truth (PDPL-friendly, consent-gated); GA4 optional/secondary behind consent, **no double-write** | Double-writing doubles load and is a PDPL liability | 2026-06-10 |
| AI Style-Finder | Deferred build; server-side proxy, per-IP/session rate limits + spend caps; default model = latest Claude (Opus/Sonnet 4.x) | Cost-DoS and key leakage are the dominant risks | 2026-06-10 |
| Search | Postgres FTS in v1 with explicit Arabic-tokenisation validation; schema designed to swap to Meilisearch/Typesense later | Ship v1 on managed Postgres; isolate the choice | 2026-06-10 |
| Jurisdiction | Saudi Arabia (`.sa`); PDPL applies (consent, retention, data handling) | Drives consent gating, retention/erasure jobs, PII encryption | 2026-06-10 |
| Pillar order | 1) Security 2) Performance 3) SEO/GEO/AEO 4) Scalability | Non-negotiable conflict-resolution order; a higher pillar always wins | 2026-06-10 |

**Definition of Done (every feature, all seven):** server-side authorized; within performance budget; server-rendered if indexable; accessible (WCAG 2.2 AA); tested (incl. per-role authz); observable; documented.

## Resolution of the central static-vs-CMS-editable tension

The platform must be **static-first/fast** *and* **fully CMS-editable**. The resolution is a **three-tier render model** in which the deploy artifact is stable and **freshness is a cache event, not a rebuild**: (A) static cacheable shell — indexable HTML sourced through the Content Layer API, served from the Cloudflare edge as cache-backed SSR; (B) Server Islands (`server:defer`) for genuinely dynamic, non-indexable holes; (C) on-demand SSR for `/admin`, the Style-Finder dynamic API, and auth callbacks. A **publish** flips status, sets `updated_at`, and **purges the affected edge cache tags** so the next request re-renders current HTML — no full SSG rebuild.

## Table of contents

1. [Rendering Strategy and Data Flow](#1-rendering-strategy-and-data-flow)
2. [Core Data Model and Schema](#2-core-data-model-and-schema)
3. [Authentication and RBAC Enforcement](#3-authentication-and-rbac-enforcement)
4. [Security Architecture](#4-security-architecture)
5. [Performance Budgets, Images, Fonts, Animation, Caching](#5-performance-budgets-images-fonts-animation-caching)
6. [Video and Media Pipeline](#6-video-and-media-pipeline)
7. [SEO / GEO / AEO Architecture](#7-seo--geo--aeo-architecture)
8. [Scalability and Data Lifecycle](#8-scalability-and-data-lifecycle)
9. [CI/CD, Testing, Observability, DR & Notifications](#9-cicd-testing-observability-dr--notifications)
10. [Open risks and follow-ups](#10-open-risks-and-follow-ups)
11. [Deferred: AI Style-Finder — security/cost requirements to honour now](#11-deferred-ai-style-finder--securitycost-requirements-to-honour-now)

## System data-flow diagram

```
PUBLIC READ PATH (Tiers A + B)
  Visitor (EN / + /ar/) → Cloudflare edge ── WAF/rate-limit ──► [HIT: cached shell] ──► Visitor
     │ MISS / island request                                   ▲ purge-by-tag on publish
     ▼                                                          │
  Astro Worker (Cloudflare adapter)  ── Tier A: cache-backed SSR (Content Layer + Zod, anon key + RLS)
                                      └─ Tier B: server:defer island → getLiveCollection (tenant-scoped)
                                            ▼ Supavisor pooler (transaction mode, :6543) → Supabase Postgres
                                            └─ Storage / Cloudflare Stream → edge image transform
ADMIN WRITE PATH (Tier C)
  Admin (React island) → Astro Worker /admin/** (prerender=false) → Supabase Edge Functions
     ── server-side RBAC (assertCap, live-recheck on privileged paths) + RLS (dual enforcement) ──►
     ├─ writes; publish/schedule flips status; ON PUBLISH → Cloudflare purge-by-tag → re-emit sitemap/llms.txt
Key boundaries: build/static read path uses the anon key under RLS (never service-role in client/build);
admin writes go ONLY through Edge Functions with server-side authz; ALL DB access via Supavisor; publish is
the SINGLE trigger reconciling static delivery with editability via tag purge. Anon tenant_id is resolved
SERVER-SIDE (GUC / fixed anon-JWT claim), never client-chosen.
```

---

## 1. Rendering Strategy and Data Flow

Resolves the central tension and unblocks Performance, SEO, and Scalability simultaneously. Closes #2 and contributes to #5/#6/#10/#11.

### 1.1 The three-tier render model

| Tier | Mechanism | Routes | Why |
|---|---|---|---|
| **A. Static shell (cache-backed SSR; "prerendered")** | `export const prerender = true` *intent* — implemented as long-`s-maxage` edge-cached SSR (see §1.4) | `/`, `/ar/`, `/services`, `/services/:slug`, `/portfolio`, `/portfolio/:slug`, `/creative-knowledge`, `/creative-knowledge/:slug`, `/about`, `/about/team/:slug`, `/contact`, `/[...slug]`, `/404`, sitemaps, `robots.txt`, `llms.txt` | Indexable content must be in the server-rendered HTML. ~90% of public surface. |
| **B. Server Islands (`server:defer`)** | `<Component server:defer>` inside a shell | "trending services" strip, search autocomplete, consent-dependent fragments, CSRF token injection | Non-indexable dynamic holes only. |
| **C. On-demand SSR** | `export const prerender = false` | `/admin/**`, Style-Finder dynamic API, auth callbacks | Live per request, authenticated, never shared-edge-cached. |

**Rule enforced in review:** if content is indexable, it goes in Tier A HTML — never a client-only fetch and never a `server:defer` island body that needs to rank.

### 1.2 Astro Cloudflare adapter config

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
export default defineConfig({
  output: 'server',
  site: 'https://braiin.station',
  i18n: { defaultLocale: 'en', locales: ['en', 'ar'], routing: { prefixDefaultLocale: false } },
  adapter: cloudflare({
    platformProxy: { enabled: true, configPath: './wrangler.jsonc' },
    imageService: 'cloudflare-binding',
    imagesBindingName: 'IMAGES',
    sessionKVBindingName: 'SESSION',
  }),
  integrations: [react()],
  experimental: { liveContentCollections: true },
});
```

`wrangler.jsonc` carries `kv_namespaces` (SESSION) and the IMAGES binding. Secrets are stored as Cloudflare **Worker Secrets** (`wrangler secret put`), per §4.1.

### 1.3 Content Layer API loaders (build/revalidate-time, Tier A)

```ts
// src/content.config.ts (services collection)
const services = defineCollection({
  loader: supabaseLoader({ table: 'services', select: '*,portfolio:portfolio_services(portfolio_id)' }),
  schema: z.object({
    tenant_id: z.string().uuid(),
    slug: z.string(),
    status: z.enum(['draft', 'scheduled', 'published', 'archived']), // matches §2.2 content_status
    is_teaser: z.boolean(),    // Gaming teaser is a boolean flag on a PUBLISHED row, NOT a 5th status
    order: z.number().int(),
    title: localized(z.string()), body: localized(z.string()),
    hero_video_id: z.string().nullable(), category: z.string().nullable(),
    seo: z.object({ /* … */ }), updated_at: z.coerce.date(),
  }),
});
```
```ts
// src/loaders/supabase.ts — anon key + RLS; only published+current-tenant rows reach the build
let q = db.from(opts.table).select(opts.select ?? '*')
         .eq('tenant_id', TENANT_ID).eq('status', 'published'); // a teaser row is genuinely status='published' (is_teaser=true), so it passes this filter
```

### 1.4 Publish without a full rebuild — Live Content Collections + on-demand revalidation

**(a) Live Content Collections** (`src/live.config.ts`) feed Server-Island holes via `getLiveCollection`, returning explicit error objects (never throwing) and `cacheHint.tags` reusing the §1.6 namespace.

**(b) On-demand revalidation via tag purge — the authoritative Tier-A freshness model (resolves the §1.4/§8.5 ambiguity):** Tier-A routes are **on-demand-rendered-then-edge-cached, not deploy-frozen SSG** — SSR served from a long-`s-maxage` cache (`public, s-maxage=31536000, stale-while-revalidate=86400`). A publish purges the route's cache tags; the next request re-renders current HTML at the Worker (a single targeted render, not a build) and re-populates the edge. Where this document says "prerendered/static," read it as "edge-cached SSR refreshed on publish."

> **Mechanism-per-tier (authoritative).** Tier A = cache-backed SSR (long `s-maxage` + purge). Tier B = Server Islands (`server:defer`, per-island `Cache-Control` + `cacheHint.tags`). Tier C = uncached SSR (`private, no-store`). §8.5's `Astro.cache.set`/`getEntry()` dependency-tracing is an **optional optimisation** on top of Tier A's tag purge, **not** a second mechanism — version-uncertain (R43, launch-blocking); the guaranteed path is the explicit purge, fallback `POST /api/revalidate`.

### 1.5 Per-section error isolation
`SectionRenderer.astro` isolates unknown types / Zod-parse failures to a collapsed fallback + `system_logs` entry; Server Islands fail to inline fallback; React-island sections use a React error boundary. The Style-Finder is a deferred island whose failure cannot take down the host page.

### 1.6 Tag-based edge cache + purge-on-publish
Deterministic `Cache-Tag` (`tenant:<tid>`, `route:<name>`, `<entity>:<slug>`, `<entity>:all`, `locale:<en|ar>`) stamped in `src/middleware.ts` (same chain as security headers §4.2 + redirects §7.2 + maintenance §4.5a). Publish Edge Function calls Cloudflare purge-by-tag with the minimal tag set. Constraints: purge-by-tag is Enterprise-only, 30 tags/call, 30k calls/24h (R1, launch-blocking).

---

## 2. Core Data Model and Schema

### 2.0 Non-negotiable conventions (apply to EVERY table)
Every application table carries `id`, `tenant_id uuid not null`, `created_at`, `updated_at`, `created_by`, `updated_by`; RLS `ENABLE`+`FORCE` from migration `0001`; `updated_at` trigger-maintained. Tenant isolation reads `tenant_id` from `app_metadata` (never `user_metadata`) via `auth.current_tenant_id()`; `with check` is mandatory on every mutating policy.

> **Anonymous tenant resolution (load-bearing — fixes the public-surface tenant fence).** Anonymous visitors carry no JWT, so a `tenant_id = NULL` predicate would reject every public read and contact-form insert. The tenant for anon is resolved **server-side, never from the client**: `auth.current_tenant_id()` falls back to a server-set GUC (`app.tenant_id`), and the anon Supabase key is issued with a fixed `tenant_id` baked into its JWT `app_metadata`.
> ```sql
> create or replace function auth.current_tenant_id() returns uuid language sql stable as $$
>   select coalesce(
>     nullif(current_setting('app.tenant_id', true), '')::uuid,            -- server-set GUC, highest trust
>     nullif((auth.jwt() -> 'app_metadata' ->> 'tenant_id'), '')::uuid )    -- baked into auth AND anon JWT
> $$;
> ```
> Public writes route through `submit-contact-form` (§3.7) which holds the resolved tenant server-side. A pgTAP test asserts an anon insert/select with no claim resolves to the correct single tenant and cannot target another.

### 2.1 Tenancy, identity, roles
`tenants`; `app_role` enum (`admin`,`content_creator`,`seo`,`developer`); `profiles` (1:1 with `auth.users`, holds `role`, `failed_login_count`, `locked_until`). **`login_attempts(id, tenant_id, email, ip_inet, succeeded, attempted_at)` is provisioned in migration 0001** so the Pillar-1 lockout control has a schema home from day one (enforcement UI lands in Phase 3; invite/reset token lifetimes — reset 1h, invite 24h — are GoTrue config).

### 2.2 Shared content lifecycle
`content_status` enum (`draft`,`scheduled`,`published`,`archived`). Gaming teaser = `status='published' + is_teaser=true` — **not** a fifth status.

### 2.3 Bilingual rule
Scalar SEO/identity field → sibling `_ar` column; document/array/rich-text → locale-keyed JSONB. NULL `_ar` ⇒ EN fallback + omit from AR sitemap.

### 2.4 Content tables
`services`, `portfolio` + `portfolio_services` (M:N), `blog_categories`, `blog_posts` (with `author_id uuid references team_members(id)` — public Person identity, §7.6), `pages`, `page_sections` (section_type list includes `stat_counters`→statistics, `team`→team_members, `certifications`→certifications, `partner_logos`; unknown types isolated by §1.5).

**Versioning — ONE polymorphic table (resolves R52):** Braiin Station standardises on a single polymorphic `content_versions(entity_type versioned_entity, entity_id, version_no, snapshot jsonb, …)` for pages, services, portfolio, and blog. **`page_versions` is removed** — page history is a `content_versions` row (snapshot = full `{page + ordered page_sections}`) exactly like every other type. Each entity carries `version_token` for optimistic locking (§8.7). One table, one rollback mechanism, no per-type version tables.

### 2.5 Leads (PII)
`lead_kind`(`contact`,`project_inquiry`,`style_finder`), `budget_band`, `timeline_band`; `internal_notes`, `ip_inet`, `consent_marketing`, `retention_delete_after`. `budget`/`timeline`/`internal_notes`/`ip_inet` restricted to **Admin + Developer** server-side (§3.6/§4.7).

### 2.6 Settings, theming, marketing chrome, admin entities
`partner_logos`, `custom_themes`, **`team_members`** (E-E-A-T authors → `/about/team/:slug`, Person JSON-LD; `profile_user_id` optional link to an admin account), **`certifications`**, **`statistics`** (stat counters: `label`, `value_numeric`, `value_suffix`), `redirects`, `site_settings` (identity, integrations, maintenance flag + IP allowlist, retention horizons).

**Dashboard notification banners — derived, not stored:** stale-content (`content_freshness` view), scheduled-today (`status='scheduled' and scheduled_for::date = current_date`), missing-images (null required media / empty `alt_text`). No `notification_banners` table exists.

### 2.7 Audit log (append-only) + system logs (clearable)
`audit_log` (INSERT+SELECT grants only, `prev_hash`/`row_hash` HMAC chain — hardening §4.8) and `system_logs` (clearable, month-partitioned) are two tables with opposite mutability guarantees.

### 2.8 Indexing & FTS (Arabic validation)
Generated `search_en`/`search_ar` tsvector + GIN. English=`'english'`; Arabic normalise first (strip tashkeel, unify أ/إ/آ→ا and ة→ه, strip kashida) then `'arabic'`.

**AR-tokenisation gate has a concrete pass bar:** a curated fixture of ≥30 AR `query→expected-doc` pairs (covering tashkeel/alef/hamza/taa-marbuta/`ال`); normalization unit assertions; and a **numeric relevance bar — recall@5 = 100% on the curated set AND zero zero-result curated queries** (a single miss fails CI). **Swap-trigger threshold (resolves R49):** swap to Meilisearch/Typesense when recall@5 < 100% on a content-representative re-baseline OR production AR zero-result rate > 15% over a rolling 30 days.

#### 2.8a Unified cross-entity search shape (pinned — resolves R50)
`UNION ALL` over services + portfolio + blog behind the single `search_content` accessor, each branch projecting `(entity_type, id, slug, title, snippet, ts_rank(...) as rank)`, ordered by `rank` with `LIMIT`. No materialised cross-entity index in v1 (a materialised view is a behind-the-accessor escalation). Did-you-mean/suggestions via `pg_trgm` similarity on zero/low-result queries.

### 2.9 Telemetry tables (partitioned, retention-bounded)
`analytics_events` (range-partitioned by `occurred_at`). All telemetry is **consent-gated** at the write boundary by the single `hasConsent(req,'analytics')` gate in **§4.12** — no row without analytics consent. Dashboards read only `rollup_*` tables. Raw retention is the single named constant `RAW_TELEMETRY_RETENTION` (value/SQL in §8.3); `system_logs` 30 days; `audit_log` never auto-dropped.

### 2.10 Requirements closed
#3 (RBAC schema half + `login_attempts`/lockout columns), #6 (redirects v1), #10 (analytics canonical + retention with the single `RAW_TELEMETRY_RETENTION` constant), #12 (tenancy); supports #2, #9 (`consent_log` + leads `consent_marketing`; full store/gate is §4.12), #13. Also models `team_members`, `certifications`, `statistics`, `media_assets.folder`/`tags`; dashboard banners are derived views.

---

## 3. Authentication and RBAC Enforcement

Governing rule: **authorization is enforced in two independent server layers that must both pass — Postgres RLS (primary) and an Edge Function/API role guard (secondary) — and the React sidebar is UX only.**

### 3.1 Three enforcement layers
RLS (authoritative, always runs); Edge `assertCap()` (independent, clean 403s + non-table logic); React `can()` (zero trust, UX only).

### 3.2 Supabase Auth flows
No public sign-up; invite-only. Login tracks failures in `login_attempts`. **Lockout:** 5 failures / 15 min → generic `423` for 15 min; identical copy for bad-password vs unknown-email. Reset 1h, invite 24h tokens.

### 3.3 JWT/role-claim flow
Custom Access Token Hook projects `user_role` + `tenant_id` into `app_metadata`; default `content_creator` coalesce fails closed. Role/tenant changes force session revocation (and the §3.7 live-recheck backstops the high-value window).

### 3.4 The role × capability permission matrix

Derived from one TS constant (`ROLE_CAPS` in `src/lib/authz/matrix.ts`). **This matrix is byte-for-byte identical to CLAUDE.md §5 and the §9.3 authz test matrix; a CI snapshot test fails on any drift between the three.**

> **Canonical role model (reconciled 2026-06-10).** The feature inventory describes **Developer** as *"full technical access + site-health panel"* — an infrastructure/technical role, **not** a content author or publisher. So: **Developer owns settings/theme/maintenance/integrations? (no — integrations are SEO) + logs/audit/site-health + leads management & PII + backup export, but has NO content-authoring, NO publish/schedule/archive.** Content authoring belongs to Content Creator (who also publishes); publish/archive/delete to Admin (archive/delete Admin-only); SEO owns meta/schema/redirects/integrations. (Supersedes an earlier draft that granted Developer broad `content.write`/`content.publish`.)

Legend: ● full · ◐ limited/own · ○ none.

| Capability | Admin | Content Creator | SEO | Developer |
|---|---|---|---|---|
| Content CRUD (services, blog, portfolio, pages/sections) | ● | ● | ◐ *(meta/SEO only)* | ○ |
| **Publish / schedule / unpublish** | ● | ● | ○ | ○ |
| Archive / hard-delete content | ● | ○ | ○ | ○ |
| Media — upload / edit metadata | ● | ● | ◐ *(meta only)* | ● |
| Media — hard-delete | ● | ○ | ○ | ○ |
| Users & roles | ● | ○ | ○ | ○ |
| Global settings / identity / localization | ● | ○ | ○ | ● |
| Maintenance / hidden pages / page visibility | ● | ○ | ○ | ● |
| Integrations (GA4, Search Console, Calendly, reCAPTCHA) | ● | ○ | ● | ○ |
| SEO meta / schema / global SEO defaults | ● | ◐ *(per-entity, view)* | ● | ○ |
| **Redirects & canonicals** | ● | ○ | ● | ○ |
| Analytics — read dashboards | ● | ● | ● | ● |
| Search analytics | ● | ○ | ● | ● |
| AI Style-Finder — questions/styles editor | ● | ● | ○ | ○ |
| AI Style-Finder — results/logic config | ● | ○ | ○ | ○ |
| Exports — `export-csv` (leads/analytics) | ● | ○ | ○ | ● |
| Exports — `export-backup` | ● | ○ | ○ | ● |
| Leads — list/manage (status, notes) | ● | ○ | ○ | ● |
| **Leads — budget/timeline/internal_notes/ip (PII)** | ● | ○ | ○ | ● |
| Theme editor | ● | ○ | ○ | ● |
| System logs (view / clear) | ● | ○ | ○ | ◐ *(view; clear=Admin)* |
| Audit log (view) | ● | ○ | ○ | ● |
| Site-health & performance panel | ● | ○ | ○ | ● *(exclusive owner)* |

**Lead PII note.** `budget`/`timeline`/`internal_notes`/`ip_inet` are Admin + Developer only; Content Creator and SEO can never read leads. A Developer `export-backup` decrypts PII (Developer holds `leads.sensitive`) but is audit-logged with row counts + status (§4.9).

```ts
// src/lib/authz/matrix.ts
export const CAPS = ['content.read','content.write','content.publish','content.delete',
  'users.manage','settings.write','maintenance.write','integrations.write','seo.meta',
  'redirects.write','analytics.read','search.analytics','exports.leads','exports.backup',
  'leads.manage','leads.sensitive','media.write','media.delete','theme.write','logs.view',
  'logs.clear','audit.view','sitehealth.view'] as const;
export const ROLE_CAPS: Record<AppRole, ReadonlySet<Cap>> = {
  admin: new Set(CAPS),
  content_creator: new Set(['content.read','content.write','content.publish','seo.meta','media.write','analytics.read']),
  seo: new Set(['content.read','seo.meta','redirects.write','integrations.write','analytics.read','search.analytics','media.write']),
  developer: new Set(['settings.write','maintenance.write','theme.write','analytics.read','search.analytics','media.write',
    'exports.leads','exports.backup','leads.manage','leads.sensitive','logs.view','audit.view','sitehealth.view']),
};
```

### 3.5 Session / cookies / CSRF
`httpOnly; Secure; SameSite=Lax` (`__Host-`) cookies; `getUser()` signature verification; double-submit `__Host-csrf` or same-origin check on all mutations.

### 3.6 RLS as primary control
`auth.tenant_id()` delegates to `auth.current_tenant_id()` (so both names share one resolver); anon-facing policies (`services_read_public`, `leads_insert_public`) use it for the server-side fallback. `services_write`/publish allow Admin + Content Creator (Developer has NO content.write); archive/delete is Admin-only via a second RESTRICTIVE policy. `leads_read`/`leads_manage` allow Admin + Developer. **`leads_safe` view omits `budget/timeline/internal_notes/ip_inet`, is NOT granted to all `authenticated`** (only service-role / lead-viewing roles); the plaintext PII gate of record is the role-checked decrypt path (§4.7), with column GRANT + view as defense-in-depth. pgTAP asserts SEO/Content Creator get zero lead access.

### 3.7 Independent role checks in Edge Functions
`assertCap` verifies JWT against JWKS and, for **RLS-bypassing privileged endpoints** (`export-backup`, `export-csv`, `leads.sensitive`, `manage-users`), **live-rechecks `profiles.role`/`is_active`/`locked_until`** so a demotion/deactivation is effective immediately (not at the 1h token TTL). `submit-contact-form` resolves `tenant_id` server-side; `search-content` has **no captcha** (incoherent per-keystroke) — edge rate-limit + Zod cap + `websearch_to_tsquery`. A test demotes a user without refreshing the token and asserts immediate 403.

### 3.8 Per-role authz test strategy
pgTAP RLS tests + Edge `{role×capability}` matrix + Playwright negative E2E; a cross-tenant zero-rows test in every tier; the anon tenant-fence test.

---

## 4. Security Architecture

### 4.1 Secrets — `astro:env` split
PUBLIC vs `context:"server", access:"secret"`. Service-role key, `ANTHROPIC_API_KEY`, Stream signing keys, `LEAD_PII_ENC_KEY`, `AUDIT_HMAC_KEY` (the latter actually lives in Vault, §4.8) never client-side. Secrets stored as **Cloudflare Worker Secrets** (`wrangler secret put` / the dashboard "Worker Secrets" encrypt panel), never in committed `.env`.

### 4.2 Security headers + CSP (strict, no `'unsafe-inline'`)
One enforcement point in `src/middleware.ts`. CSP: `script-src 'self' 'nonce-…' …`; **`style-src 'self' 'nonce-…'` — NO `'unsafe-inline'`** (theme = CSS custom properties; Tiptap = class-based, `style=` stripped by the sanitizer; build-time inline `<style>` blocks carry the nonce); **`img-src` drops `data:`** (pasted images become real Storage uploads, https only); **`connect-src 'self' …supabase …cloudflarestream`** — the consent-gated RUM beacon and Sentry tunnel are **same-origin** so `'self'` covers them. HSTS preload, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP. Report-Only one cycle, then enforce. The CSP ships **strict** — no `'unsafe-inline'` — at enforce (R18 resolved).

### 4.3 Theme-editor `postMessage` bridge
Explicit `targetOrigin`; receiver validates `event.origin` against allowlist AND `event.source === window.parent`; versioned Zod envelope; theme tokens applied as CSS custom properties only.

### 4.4 Output sanitisation + form input
`sanitize-html` allowlist on write AND render; **`style` is NOT in any allowedAttributes set** and **`allowedSchemesByTag.img: ['https']`** (no `data:`/`blob:`) — this is what lets `style-src` ship without `'unsafe-inline'`. `ContactLead` Zod schema (length-bounded, E.164). **`SearchQuery`** Zod cap (≤64 chars, no control chars); **search uses `websearch_to_tsquery` (never raw `to_tsquery`)** + per-query `statement_timeout` + capped rows; a test feeds tsquery metacharacters/overlong input and asserts safe handling.

### 4.5 Abuse control — WAF / rate limits
Rate-limit table: contact 5/10min/IP; search 30/min/IP; **AI 20/hr/session AND 60/hr/IP**; exports 3/hr/user. **The Cloudflare WAF rule matches the documented limit — `/api/ai/style-finder` → period 3600, 60 requests, mitigation `block`** (NOT 10/60s ≈ 600/hr). Training-deny UA block list = the full `{GPTBot, ClaudeBot, Google-Extended, CCBot, Applebot-Extended, Meta-ExternalAgent}` set, sourced from the same code-owned token map as the robots.txt snapshot test. An integration test asserts the 61st IP / 21st session call is refused with zero upstream Anthropic call.

### 4.5a Maintenance mode + IP allowlist (Worker-level, pre-cache)
A Worker-level check in `src/middleware.ts` runs **before** edge-cache lookup, short-circuiting non-allowlisted IPs to a `no-store` 503; flag + allowlist in `site_settings`/KV; `/admin` exempt. Enabling maintenance requires **no cache purge** (the Worker runs ahead of cache). Toggling is `settings.write`/`maintenance.write` (Admin/Developer), audit-logged.

### 4.6 AI Style-Finder — server-side proxy hard requirements (deferred build, binding now)
Server-side proxy only; per-IP + per-session rate limit before any token spend; spend cap in a strongly-consistent Durable Object; prompt-injection hardening (delimited untrusted block, structured JSON output); answer-hash result cache; ships first as a `501` stub with the full wrapper stack tested.

### 4.7 PII handling for leads
Envelope-encrypt `phone`/`budget`/`email`; **plaintext gating of record is the role-checked decrypt path** (decrypt only for `leads.sensitive` holders = Admin/Developer), with the RLS column GRANT + `leads_safe` view as defense-in-depth. Content Creator/SEO cannot read leads. Every view/export audit-logged; retention purge (default 24mo, spam 30d — pending legal sign-off).

### 4.8 Append-only, tamper-PROOF audit log (launch-blocking)
A `BEFORE INSERT` trigger (`audit_chain_stamp`, `SECURITY DEFINER`, owned by a dedicated role) computes `prev_hash`/`row_hash` on **every** insert path including service-role — callers cannot supply/skip/forge them. `AUDIT_HMAC_KEY` is read from **Supabase Vault by the definer only** (not the `astro:env` store an admin can reach). The per-tenant chain head is **anchored hourly to an object-locked R2 bucket in a separate account** (anti-rollback). An **hourly verifier pages on-call** (not just logs) on mismatch. UPDATE/DELETE revoked for all roles via grant + `do instead nothing` rules.

### 4.9 High-value endpoint lockdown
`export-backup`/`export-csv`: live-rechecked `assertCap`; **per-user (3/hr) AND per-tenant aggregate** rate limit; **two audit entries** (attempt before the dump + outcome with row count/status); abnormal-export-volume alert; `no-store`; PII decrypted only for `leads.sensitive` holders (Admin + Developer qualify; a role without it cannot reach the endpoint). A test asserts a Developer backup is audited with row counts.

### 4.10 Supply chain
Pinned deps + lockfile + `npm ci`; Renovate; `npm audit --audit-level=high` + Socket/osv-scanner; Actions pinned to SHAs.

### 4.11 Not owned here
Auth/RBAC/RLS authoring → §3. **Cookie-consent store, category model, and gate function → §4.12**, consumed by §8.2/§9.6. robots/llms content → §7. Partitioning → §8.

### 4.12 Privacy, Consent & PDPL
**First-party consent store:** signed `__Host-consent` cookie (server- and client-readable) + a `consent_log` audit row (`subject_key` hashed id, `categories`, `policy_version`, `granted_at`). Default **denied** pre-interaction. **Granular categories:** `functional` (always on), `analytics` (denied until granted), `marketing` (denied until granted). **Single gate `hasConsent(req, category)` in `packages/consent/gate.ts`** — the one implementation imported by every caller. **Mandatory call sites:** `ingest-telemetry` (drops the write without `analytics` consent — no `analytics_events` row without consent), the **RUM beacon** (client check + server re-check), **GA4 tag injection** (only with `marketing` consent; Consent Mode v2 denied otherwise; never server-double-written), and the **YouTube/Vimeo facade** (real iframe only after `marketing` consent or click-through). Re-evaluation on change; persistent "Cookie settings" link for withdrawal. **Lawful basis per purpose** documented; operational telemetry (Sentry/`system_logs`/`/healthz`/synthetics) is legitimate interest, PII-scrubbed, consent-independent. **Cookie inventory** (snapshot-tested) + **withdrawal/DSAR** linkage (export-self/delete-self, §4.7). **Until built, unblock #9 is NOT closed.**

---

## 5. Performance Budgets, Images, Fonts, Animation, Caching

### 5.1 Budgets (public routes; `/admin` exempt from CWV, gated on bundle size)

| Metric | Budget | Notes |
|---|---|---|
| LCP | < 2.5 s | poster frame is the hero LCP |
| INP | < 200 ms | source of truth = field RUM |
| CLS | < 0.1 | explicit width/height; metric-override fonts |
| TBT (lab proxy for INP) | ≤ 200 ms | CI lab cap |
| Lighthouse Perf / A11y / SEO | ≥ 95 each | incl. an `/ar/` RTL route |
| Per-route client JS | ≤ 100 KB gzipped | `hls.js` post-LCP, excluded |
| EN+AR fonts per route | ≤ 180 KB woff2 | AR face counts |
| Hero face | ≤ 35 KB (Latin) / 45 KB (Arabic) | preload only this face |
| Poster image | ≤ 80 KB | Stream thumbnail |

### 5.2 CI gates
Gate A `@lhci/cli` (minScore 0.95, numeric LCP/CLS/TBT caps, unsized-images/modern-formats/font-display as errors, incl. `/ar/`); Gate B `size-limit` (per-island JS ≤100 KB, fonts ≤180 KB, hero face ≤35 KB); Gate C `budget.json`.

### 5.3–5.7 Images / Fonts / Animation / Caching / RUM
Astro `<Picture>` (AVIF→WebP, explicit width/height); edge transforms with `cacheKey` = full-size source URL only, `format=auto`. Self-hosted woff2 subset per script; `font-display: swap` + metric-overrides; preload only the hero face per language. Compositor-only animation; `content-visibility: auto`; `prefers-reduced-motion` disables (not slows); CSS-only marquee with a dedicated field-INP probe. Static shell edge-cached, tag-based purge tied to publish; image transform cache is a separate namespace. RUM web-vitals beacon is **consent-gated, same-origin, first-party only** (§4.12), wired to the §5.1 budgets.

---

## 6. Video and Media Pipeline

Cloudflare Stream is the streaming CDN of record; no raw MP4 hero autoplay. Closes #4. tus resumable direct-creator upload (Stream API token server-side only); encode-ready webhook is the source of truth for "playable" (`Webhook-Signature` verified). `media_assets` (tenant-scoped, RLS) now carries `tags text[]` and `folder text` (media-library "Folders"). `<StreamPlayer>` island: poster is the server-rendered LCP `<img>`; `preload="none"`; `hls.js` loads only on IntersectionObserver or click, outside the per-route JS budget; muted-autoplay only when `muted===true && variant!=='inline'` and never under `prefers-reduced-motion`; captions force native controls. Signed RS256 URLs minted server-side (max 24h) for gated assets. `ref_count`-driven GC (30-day grace, Admin-gated hard-delete); egress metered into `media_egress_daily`. YouTube/Vimeo facade coordinated with Consent (§4.12).

---

## 7. SEO / GEO / AEO Architecture

Closes #6/#7/#8. Indexability contract: all indexable content (and `/ar/` twins) in initial HTML via `<SeoHead>` (sole `<head>` SEO emitter). Redirects module v1 (real 301/302/308 at the edge, KV-cached, purged on write; no chains>1, no loops, can't redirect a live slug). Per-language self-referential canonicals; reciprocal hreflang + `x-default`→EN; AR meta/OG Zod-required before AR publish. Eight Zod-validated JSON-LD builders (Organization, WebSite, Service, Article, FAQ, Breadcrumb, CreativeWork, Speakable) with a blocking CI validation gate (EN+AR). **Three-tier robots.txt** (TRAINING incl. Meta-ExternalAgent → Disallow; RETRIEVAL incl. Bingbot → Allow; USER → Allow), code-owned + snapshot-tested; WAF is enforcement. **E-E-A-T author pages source from the `team_members` table** (§2.6); `blog_posts.author_id` → `team_members`; anonymous published authorship blocked. Dynamic sitemaps + `llms.txt` regenerate on publish (same source query, tag-purged). GEO answer-first 40–60w summaries, named/sourced stats, truthful `dateModified`. `seo-schema` blocking CI gate.

---

## 8. Scalability and Data Lifecycle

### 8.1 Pooling
All runtime DB access via Supavisor transaction mode (`:6543`, `pgbouncer=true`, `prepare:false`); `:5432` for migrations + `pg_cron`. Edge Functions `max:1`; SSR Worker `max:3–5`.

### 8.2 ONE canonical analytics source
First-party self-hosted Postgres is canonical; GA4 consent-gated/secondary; **no double-write**. `ingest-telemetry` enforces the §4.12 `hasConsent(req,'analytics')` gate at the write boundary — no `analytics_events` row without analytics consent.

### 8.3 Partitioning + retention (single named constant)
> **Single source for the raw-retention number.** The raw horizon for pageviews/CTA/search/service-interest is the **one named constant `RAW_TELEMETRY_RETENTION`**, referenced identically here, in §2.9, in CLAUDE.md, and in the delivery plan. **Launch value `90 days` (= `'3 months'`)** for this PDPL jurisdiction — pending legal sign-off (R21/R46 flag it may go shorter, never longer). Stored in `site_settings`.

```sql
update partman.part_config
   set retention = '3 months',   -- = RAW_TELEMETRY_RETENTION (90 days); single source, pending legal sign-off
       retention_keep_table = false
 where parent_table = 'public.analytics_events';
```
`web_vitals` 90d; `system_logs` 30d; `audit_log` indefinite. Rollups idempotent (`on conflict … do update`); rollup schema must lead dashboard requirements (R45).

### 8.4 Schema-wide tenancy; 8.5 build time stays flat
Tenant predicate first in every policy and composite index. **§8.5 freshness mechanism:** the authoritative, guaranteed mechanism is the explicit edge tag purge (§1.4(b)/§1.6) on cache-backed-SSR Tier-A routes; `Astro.cache.set` dependency-tracing is an optional optimisation enabled only after staging verification (R43, launch-blocking; fallback `POST /api/revalidate`).

### 8.6–8.8 Media egress; optimistic locking; third-party resilience
`version_token` optimistic lock (`WHERE version_token=$expected` → 409). **Shared resilience helper** (backoff + full jitter, capped retries, circuit breaker, idempotency keys, `provider_quota`) wraps every external call; AI provider enforces per-IP+session limits and a strongly-consistent spend cap; degrades to cached/rule-based on breaker-open.

---

## 9. CI/CD, Testing, Observability, DR & Notifications

### 9.1–9.5 Type safety, testing pyramid, per-role authz, CI/CD, a11y
TypeScript strict; Zod single source. **The authz matrix (§9.3)** is byte-for-byte consistent with §3.4 and CLAUDE.md §5: `service.publish` = Admin+Content Creator; `read lead.budget/timeline` = Admin+Developer; `content.write` = Admin+Content Creator; `settings.write/export-backup` = Admin+Developer; `integrations.write/seo_meta/redirects.write` = Admin+SEO; `audit_log.delete` = deny all. Plus the targeted regression tests: anon tenant fence, live-recheck, lead-PII, notify-lead 401, search safety, role-matrix snapshot, AI limits, audit chain. CI gate order mirrors pillars. Three isolated Supabase projects; Workers Builds previews. WCAG 2.2 AA blocking (axe + 4 targeted checks).

### 9.6 Observability
Operational telemetry (Sentry same-origin tunnel + `system_logs`, synthetics, `/healthz`) is legitimate-interest, PII-scrubbed, consent-independent. **Field web-vitals (RUM) is consent-gated** (carries `session_id`, `analytics` category) — client checks before `sendBeacon`, the same-origin Worker endpoint re-checks server-side (§4.12).

### 9.7 DR
PITR (RPO ≤ 2 min, 28-day, RTO ≤ 1 hr) + off-platform `pg_dump` → separate-account encrypted R2 + nightly media mirror → object-locked R2 (also the audit-chain anchor target, §4.8). Quarterly timed restore drills.

### 9.8 Lead notifications (authenticated webhook, no PII on the public hop)
Trigger → `pg_net` → `notify-lead`. **The inbound trigger→Worker call is authenticated** — `Authorization: Bearer <NOTIFY_LEAD_SECRET>` sourced from **Supabase Vault** (never `PUBLIC_*`), constant-time verified, `401` otherwise — and carries **only `lead_id` + `tenant_id`** (no PII over the public `*.workers.dev` hop); the Worker re-fetches the row server-side, so a forged id resolves to nothing. `/notify-lead` is WAF rate-limited; a test asserts an unsigned POST is rejected 401. Fan-out applies the same PII field-gating via a **shared field-visibility helper** (budget/timeline/internal_notes omitted unless the recipient holds `leads.sensitive`). The outbound generic-CRM webhook is HMAC-signed (`X-Braiin-Signature`).

---

## 10. Open risks and follow-ups (R1–R62, owner-grouped)

Key updates: **R5** → revisit with §4.12 (consent fragments are Tier-B islands so the shell stays cacheable). **R6a** → maintenance check must run before cache lookup (§4.5a). **R8** → `internal_notes`/`ip_inet` removed from `leads_safe`, grant restricted; pgTAP guards. **R9/R10** → mitigated by the §3.7 live-recheck. **R16** → audit chain hardened in §4.8 (launch-blocking). **R18** → CSP ships strict, no `'unsafe-inline'` (resolved). **R43** → elevated to launch-blocking (verify the Tier-A cache layer / tag-purge→re-render path in staging). **R49** → swap-trigger threshold defined (§2.8). **R50** → unified search shape pinned (§2.8a). **R52** → single polymorphic `content_versions`; `page_versions` removed (closed). **R21/R46/R55/R56** → PDPL legal sign-off on retention (incl. `RAW_TELEMETRY_RETENTION`), erasure-vs-immutable-audit, backup retention.

### 10.10 Launch-blocking summary
Resolve before build/launch: **R1** (Cloudflare plan tier), **R43** (Tier-A cache/freshness path in staging), **R21/R55/R56** (PDPL retention/erasure/backup sign-off), **R35/R49** (Arabic FTS must pass its numeric pass bar or the swap is pulled forward), **R20** (Supabase encryption/pgsodium availability), the **audit-log hardening** (§4.8: DB-computed hash via BEFORE INSERT trigger, Vault key, hourly R2 anchor + paging verifier), and **consent (§4.12)** — unblock #9 is not closed until built.

---

## 11. Deferred: AI Style-Finder — security/cost requirements to honour now

The full quiz logic is deferred; the security/cost envelope is binding today. The endpoint ships as a `501` stub with the full wrapper stack (rate limit, spend cap, auth context, Zod input schema) existing and tested. **§11.2 binding requirements (9 rows, all with where-enforced + proving-test):** server-side proxy only; default model latest Claude (Opus/Sonnet 4.x); per-IP (60/hr) + per-session (20/hr) limits before any token spend (test: 61st IP / 21st session call refused with zero upstream call, asserting the actual configured numbers); strongly-consistent Durable-Object spend cap + alert; prompt-injection hardening (structured JSON output); answer-hash result cache; module boundary that cannot take down the host; backoff + graceful degrade; PDPL on captured `style_finder` leads (same PII posture). What remains deferred: quiz taxonomy, scoring/matching, prompt template fields, session storage, `/discover` per-step UX (the result page is `noindex` + robots-disallowed). The §11.2 contract is the acceptance gate.