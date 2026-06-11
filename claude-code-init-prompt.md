# Claude Code — Braiin Station Initialization Prompt

**How to use:** open Claude Code in your project directory (or an empty repo for a fresh build) and paste everything between the markers below as your first message. It tells Claude Code to *confirm the unknowns and produce an architecture plan + `CLAUDE.md` before writing feature code*, then build in phases with Performance, Security, SEO, and Scalability as hard requirements. Attach `braiin-station-analysis.md` and the feature inventory alongside it if you can.

---

=== BEGIN PROMPT ===

You are the lead engineer for **Braiin Station**, a production creative-agency platform. Treat this as production-grade work, not a prototype. Optimise relentlessly for four pillars in this order of non-negotiability: **Security, Performance, SEO/GEO/AEO, Scalability.**

## Product context
Braiin Station is one platform with four parts:
1. A bilingual (English + Arabic, RTL) marketing/portfolio public site for 14 creative services, where every page section is CMS-driven, toggleable, re-orderable, and styled from an admin — with per-section error isolation.
2. An **AI Style-Finder** lead-gen web app (guided quiz → style library → AI recommendation → lead capture). Build only a clean, well-isolated placeholder/module boundary for now; the full logic is specified separately. Do not stub insecure AI calls.
3. A **Creative Knowledge blog** engineered to rank on Google and be cited by AI answer engines (TOC, key-takeaways, FAQ, author boxes, related posts, JSON-LD throughout).
4. An authenticated **admin/CMS** governing all of the above, with four roles: **Admin, Content Creator, SEO, Developer.**

Each service detail page opens with its own hero video. Gaming launches as a "coming soon" teaser.

## Assumed stack — CONFIRM BEFORE BUILDING
I believe the stack is **Astro (public site) + a React admin (Astro islands or SPA) + Supabase (Postgres, Auth, Edge Functions, Storage) + Tiptap**, reusing modules from a prior platform. **Do not assume this is correct.** Your first task is to verify the actual stack, hosting target, and adapter, and adapt every recommendation below accordingly. If anything conflicts with reality, surface it and propose the correct approach.

## DO THIS FIRST — before writing any feature code
1. Ask me the open questions you need answered to proceed safely. At minimum, get decisions on: (a) confirmed stack + hosting/adapter; (b) rendering model; (c) whether RBAC is enforced server-side today; (d) i18n URL strategy; (e) analytics canonical source; (f) single- vs multi-tenant.
2. Produce a concise **architecture decision document** (`/docs/architecture.md`) covering the rendering strategy, data flow, auth/RBAC enforcement model, caching/invalidation, media/video pipeline, and the i18n approach.
3. Create a **`CLAUDE.md`** at the repo root capturing the conventions, the four-pillar requirements below, the role/permission matrix, the performance budgets, and "definition of done" so every future change is held to them.
4. Propose a **phased delivery plan** (foundation → public site → blog → admin/CMS → AI Style-Finder spec hand-off) and wait for my go-ahead before implementing each phase.

Only after 1–4 are agreed, start implementing.

## Architecture — resolve the central tension explicitly
The product must be **static-first and fast** *and* reflect a **fully CMS-editable** site. Reconcile this, don't ignore it:
- Render indexable content statically/SSR so it is in the HTML for crawlers and AI engines — never client-only fetches for SEO-critical content.
- Use **Astro Server Islands (`server:defer`)** for the few genuinely dynamic/personalised pieces over a static, cacheable shell.
- Use **on-demand rendering** (adapter) for the authenticated admin.
- Refresh published CMS content **without full rebuilds** via on-demand revalidation/ISR or Astro **Live Content Collections**; never require a full site rebuild per content edit.
- Source content (services, portfolio, blog, pages/sections) through the **Content Layer API** with type-safe schemas.

## SECURITY — hard requirements (highest priority)
- **Enforce authorization server-side on every read and write.** Implement **Postgres Row-Level Security** policies per role AND independent role checks inside every Edge Function/API route. Treat all client-side gating (sidebar/menu visibility) as UX only, never as a security control. Write tests proving each role cannot exceed its permissions.
- **Lock down high-value endpoints:** full-content/backup export and lead CSV export must require Admin/Developer, be checked server-side, rate-limited, and audit-logged.
- **Secrets:** use type-safe server-only env handling (e.g. Astro `astro:env`) with strict server/client separation. The Supabase service-role key and any AI provider key must never reach the client bundle. Per-environment secrets; nothing committed.
- **PII (leads: name/email/phone/budget/timeline):** confirm encryption at rest, log access/exports of leads, define a retention policy, and gate sensitive fields server-side.
- **Consent + privacy:** implement cookie consent / granular opt-in; gate analytics and visitor tracking on consent. Add Privacy Policy, Terms, and Cookie Policy pages.
- **Headers:** ship a strict Content-Security-Policy (account for embedded media + the iframe theme-preview), HSTS, X-Content-Type-Options, Referrer-Policy, and deliberate `frame-ancestors`.
- **Theme-editor `postMessage` preview:** strictly validate `event.origin` on both ends and scope to a trusted origin.
- **Input handling:** sanitise all Tiptap/rich-text HTML on output (allowlist); validate and escape all public form input server-side.
- **Abuse/rate limiting:** keep login lockout + reCAPTCHA; add edge rate limiting on search autocomplete and (critically) any AI endpoint, with per-IP/session limits and spend caps. Add a WAF if the host supports it.
- **AI Style-Finder:** all model calls go through a server-side proxy with rate limits, spend caps/alerts, prompt-injection hardening, and result caching. Bake these in as requirements even though full logic is deferred.
- **Audit log:** append-only / tamper-evident, separate from clearable system logs.
- **Supply chain:** pin dependencies, enable automated dependency + vulnerability scanning in CI.

## PERFORMANCE — hard requirements
- **Budgets enforced in CI (fail the build on regression):** LCP < 2.5s, INP < 200ms, CLS < 0.1, Lighthouse ≥ 95 on public pages, and a per-route JS budget (target ≤ 100KB gzipped). Keep the existing web-vitals collection and wire it to these targets.
- **Video pipeline (the #1 risk — 14 service hero videos + showreel):** poster frames for LCP, `preload="none"` + lazy/deferred load, adaptive bitrate (HLS) or a streaming CDN (e.g. Mux/Cloudflare Stream/Bunny), muted-autoplay rules, and a reduced/mobile-bandwidth fallback. No raw MP4 hero autoplay.
- **Images:** serve AVIF/WebP, correct `srcset`/`sizes`, explicit width/height (protect CLS), and cache on-the-fly transforms at the CDN edge so the origin isn't hammered.
- **Fonts:** self-host + subset (EN and AR), `font-display: swap`, preload the hero font; include AR font in the budget.
- **Animation:** GPU-friendly transforms only, `content-visibility` where useful, honour `prefers-reduced-motion`; measure the client-logo marquee's INP impact specifically.
- **Caching:** edge cache the static shell with granular, tag-based invalidation tied to the publish/revalidate flow.

## SEO / GEO / AEO — hard requirements
- All indexable content (services, portfolio, blog) must be in server-rendered HTML.
- **Build the redirects/canonical module in v1** (301s + canonical management) — slugs will change; do not defer it.
- **i18n:** path-based EN/AR (`/` + `/ar/`), emit `hreflang` pairs + `x-default`, per-language canonicals, both languages in the sitemap, complete AR metadata/OG (not afterthoughts).
- **Structured data:** keep/extend JSON-LD builders (Organization, WebSite, Service, Article, FAQ, Breadcrumb, CreativeWork, Speakable) and **validate schema automatically in CI** for every entity type.
- **AI-crawler policy:** write a deliberate `robots.txt` distinguishing training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot, Applebot-Extended) from retrieval/citation crawlers (OAI-SearchBot, PerplexityBot, Claude-SearchBot, BingBot) from user fetchers (ChatGPT-User, Claude-User) — default to allowing retrieval crawlers for citation surface unless I say otherwise. Add an `llms.txt` index kept in sync with robots.txt (guidance, not access control).
- **GEO content patterns:** answer-first article templates, room for named statistics and quotations, strong author/E-E-A-T pages, and a content-freshness/refresh workflow.
- **Sitemaps:** auto-generated on publish with accurate `lastmod`.

## SCALABILITY — hard requirements
- **Database connections:** route all DB access through a pooler (Supavisor/PgBouncer, transaction mode) to avoid serverless connection exhaustion.
- **Telemetry volume:** visitor tracking, page-view/CTA tracking, service-interest aggregation, search analytics, web-vitals, system logs, and audit logs are append-heavy. Partition or roll up time-series data, enforce retention/aggregation jobs, and pick ONE canonical analytics source (self-hosted or GA4) rather than double-writing. "Clear old logs" is not a retention policy.
- **Builds:** incremental/on-demand revalidation so content edits never trigger a full rebuild; keep build time flat as bilingual content grows.
- **Search:** start on Postgres FTS but verify Arabic tokenisation/quality; design so a dedicated index (Meilisearch/Typesense/Algolia) can be swapped in if AR/scale demands. Debounce + cache autocomplete.
- **Media:** offload video to a streaming CDN; add lifecycle cleanup for unused media; treat egress as a monitored cost line.
- **Concurrency:** add optimistic locking / conflict detection for autosave + multi-editor scenarios.
- **Multi-tenancy:** if this will serve multiple agencies, add `tenant_id` + tenant-scoped RLS from the start; otherwise document it as explicitly single-tenant.
- **Third-party limits:** retry/backoff + quota handling around GA4, Search Console, Calendly, and the AI provider.

## Engineering practices (apply throughout)
- TypeScript strict mode; typed schemas (Zod) for all content and form input.
- **Testing:** unit + integration + Playwright e2e + **explicit per-role authorization tests** + visual regression for the section system + automated a11y (axe). No feature is "done" without tests.
- **Accessibility:** target WCAG 2.2 AA — contrast-audit the dark/neon palette, full keyboard nav, captions/controls on video, `prefers-reduced-motion`, and RTL a11y.
- **CI/CD:** preview deploy per PR, versioned DB migrations, a rollback path, separate staging and production.
- **Observability:** keep error + web-vitals monitoring; add uptime/synthetic checks with alerting.
- **DR:** automated DB + storage backups with periodic restore drills; define RPO/RTO. Manual JSON export is not a backup.
- **Notifications:** add email/Slack/webhook alerts on new leads (in-dashboard only is insufficient for fast follow-up).
- Keep changes small, explain trade-offs, and update `CLAUDE.md` and `/docs/architecture.md` as decisions evolve.

## Definition of done (every feature)
Server-side authorized • within performance budget • server-rendered if indexable • accessible (AA) • tested (including authz) • observable • documented. If a change can't meet all seven, flag it and propose the fix rather than shipping it.

Begin by asking your clarifying questions and proposing the architecture doc, `CLAUDE.md`, and phased plan. Do not write feature code until those are agreed.

=== END PROMPT ===

---

### Notes on tuning this prompt
- **If it's a fresh build vs. an existing repo:** the prompt works for both, but if you're porting the prior platform, add a line telling Claude Code where the existing code lives so it audits the reused modules (especially RBAC enforcement) rather than trusting the inventory's descriptions.
- **Trim for your model/runtime:** if the prompt is too long for comfortable iteration, keep the "DO THIS FIRST", the four pillar blocks, and "Definition of done"; the engineering-practices block can move into `CLAUDE.md` after the first response.
- **Pair it with the analysis file:** the gap report (`braiin-station-analysis.md`) is the "why" behind these requirements — handing both to Claude Code gives it the reasoning, not just the rules.
