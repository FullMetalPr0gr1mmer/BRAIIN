# Admin v2: port the client's admin prototype onto the real CMS

> **The program document.** Approved by the owner on 2026-10-03. It is the plan the slices
> follow, one branch and one PR per slice, merged by the owner (a merge is a deploy).
> Where a design document in this folder disagrees with it, this document wins: its
> program decisions (P-1 to P-15) and the verification findings were applied after the
> designs were written. CLAUDE.md stays the engineering standard; each slice that changes
> a rule amends it (see "Standard amendments").

| File | What it holds |
|---|---|
| README.md | This program: decisions, tracks, slices, amendments, owner items, risks |
| [ui.md](ui.md) | Track UI design: tokens, shell, component and field kits, every screen (AV-01 to AV-34) |
| [releases.md](releases.md) | Track REL design: drafts, `apply_release`, purge, preview, versions (R0 to R16) |
| [crm.md](crm.md) | Track CRM design: leads v2, contacts, tasks, the Sales role (CRM-1 to CRM-14) |
| [verification.md](verification.md) | The adversarial review of the three designs, claim by claim |
| [deviations.md](deviations.md) | The deviations register and the client's TDD checked row by row |

## Context

The client delivered:
- **The admin prototype** `admin.html`: 6.5k lines, 44 routes, a localStorage demo.
- **A developer handoff** (`braiin-admin-handoff`), containing:
  - `ADMIN_TDD.md`;
  - the prototype sources (`src/admin/app.css`, `core.js`, `screens_*.js`, `data.js`);
  - the nine public pages with a preview bridge;
  - their Playwright checks.

The client calls the prototype "exactly how the admin should look": every screen, field, rule and line of copy is final, and "the prototype is the specification".

The repo already has a working admin, authorized on the server: about 35 screens on generic `ResourceTable`/`ResourceForm`, RLS + `assertCap()`, and per-entity publish with optimistic locking. The job is to make it look and work like the prototype while editing exactly the data the public site renders. The standard does not bend: CLAUDE.md pillars, CSP, PII rules, and a role matrix changed only by reviewed amendments.

How this plan was built:
1. A read-only mapping of all 44 routes against the code (11 agents).
2. Three architecture designs: releases, CRM + Sales, and UI/IA.
3. An adversarial verification pass of 4 agents, which found 10 release fixes, 8 CRM fixes, 12 UI fixes and a TDD coverage table. Its corrections are folded in below.

The designs and the verification are the other files in this folder (table above).

### Owner decisions (2026-10-03)

| # | Decision |
|---|---|
| A1 | **Reskin + CRM core now** (Contacts, Tasks, pipeline, notes/timeline on our data). **No outbound email/WhatsApp.** Inbox, Campaigns, Automations, Templates, CRM reports, Export & audiences and Get connected are a later phase. |
| A2 | Keep Admin / Content Creator / SEO / Developer. New roles arrive with the CRM, each through a reviewed amendment. |
| A3 | **Site-wide release**: drafts pile up, one Publish applies them atomically and purges the cache, and numbered versions give preview and rollback. |
| A4 | **A 5th role, Sales**, in this program, after the CRM core: leads, contacts, tasks, pipeline, notes; no content, settings, exports or bulk contact details. |
| A5 | **Uploads to Supabase Storage**: public bucket, images only, served through the existing transforms. Video stays as it is until Stream (KAN-20). |
| A6 | **Full fidelity**: every prototype feature the standard allows is built in this program, about 80 PRs. Only deviations the standard requires, or ones the owner approves, remain. |

## Hotfixes: live issues found by the verification (shipped first)

Small PRs off `main` that wait for nothing else. **H1 closed a live PDPL gap.** They are
#29 (H1), #30 (H2, with migration 0030), #31 (H3) and #32 (H4); #33 records EXC-011 so the
supply-chain gate lets them merge.

| # | Fix | Evidence |
|---|---|---|
| H1 | The lead contact-details reveal is fail-closed. `GET /api/admin/leads/[id]?pii=1` writes `lead.view_pii` directly and answers 403 if the audit row can't be written, as `applications/[id].ts` already does. The LeadsPanel notes textarea stays locked until a reveal, so saving no longer wipes notes. Tests added. | The audit is queued in `defineAdminRoute`, and a failed `writeAudit` doesn't block the decrypted response. Notes overwrite with `''` (verified D1, D4). |
| H2 | Leads grants: check `has_table_privilege('authenticated','public.leads', insert/delete)` on production. The migration revokes table-wide INSERT/UPDATE/DELETE, grants UPDATE on `status, internal_notes` only plus explicit service-role grants, and checks postconditions. | 0011 leaves table-wide UPDATE, and probably INSERT/DELETE, to `authenticated` (verified D3). |
| H3 | Guard `/_image`: a custom endpoint wraps the adapter and allows only listed widths (the union of component widths), formats (avif/webp/jpg/png) and quality values; anything else is a 400. Tests added. | The free Images quota is 5,000 unique transforms a month. Any visitor can burn it with arbitrary `w`/`q`, after which every image (LCP posters included) fails with error 9422. |
| H4 | Run `size-limit` in CI (`ci.yml`, after Build). | CLAUDE.md §6 claims this gate exists; no workflow runs it. |

### How we treat the client's TDD

The TDD's *product* requirements are the spec. Its *stack* suggestions are mapped onto our locked stack (§2) instead of adopted.

| TDD | Here |
|---|---|
| Keep the vanilla SPA; replace `load/save/dirty/publish` | Port the look into React islands and zero-JS Astro primitives. The client's `app.css` is the CSS source, ported verbatim-first. The prototype JS cannot ship under the nonce CSP (§3/§7): it has 464 inline `style=` attributes, runtime `<style>` injection, a `data:` logo and innerHTML templates, and its role checks are client-side only. |
| Hash router, `GET /api/state` | Server routes `/admin/**` (Tier C) with per-page server authz and per-resource APIs |
| Draft content set + `POST /api/publish` | Track REL: `content_drafts` → atomic `apply_release` → numbered `content_releases` |
| Static regeneration on publish | "Publish = cache event": tag purge. Nothing caches Tier A today, so pages are always fresh. |
| Bridge patching `[data-i]` innerHTML over `postMessage('*')` | A staff-only server-rendered preview with drafts overlaid, reloaded about 1 s after autosave, behind one hardened bridge (same-origin targetOrigin, origin and source checks, Zod envelope) |
| 7 roles, editable matrix, per-person grants, View as | 5 roles (A2/A4). The read-only matrix is generated from `ROLE_CAPS`; RLS cannot express per-person overrides. |

### What the mapping found

- **Content already matches; the look and the editing model do not.**
  - The prototype's 28 services, 5 disciplines, cases, header menu, theme defaults and intro timing equal our seed (0 diffs).
  - What differs is the **look** and the **editing model**. Today's admin is gold/paper with radius 0. The prototype is a page-centric editor with a live preview, in Klein `#0024BC` with a midnight sidebar.
- About 60% of screens are restyle/extend; CRM, marketing and setup are net-new.
- **Built but never wired into the UI**: entity SEO, media usage, export-backup, the reorder endpoints, and `content_versions` (written by triggers, read by nothing).
- **Gaps that slices fix**:
  - nothing purges the cache;
  - `frame-src` lacks `'self'`;
  - the page-visibility endpoint is refused by RLS;
  - `custom_themes` is applied nowhere;
  - spam leads are never purged early;
  - staff can forge `content_versions` rows;
  - the §5 snapshot test parses CLAUDE.md only;
  - `media:all` is missing on About, Our Work, All projects and case studies.

## Program decisions (reconciling the designs, the TDD and the verification)

- **P-1 Port, don't paste.**
  - React is used only for stateful screens. Zero-JS Astro primitives cover the shell, page heads, cards, tables, KPIs and SVG charts (each chart with a table alternative). Vanilla enhancers cover sortable and confirm.
  - CSS is a verbatim-first port of `app.css` plus the per-screen CSS in `screens_*.js`:
    - resets are scoped;
    - literals become tokens;
    - `.on` becomes ARIA-state selectors;
    - a small class layer replaces the inline styles;
    - every hook current islands use is kept.
  - Copy is ported verbatim unless it is untrue here.
- **P-2 Publishing rights come from today's capabilities. No new capability.**

  | Item | Who can publish it |
  |---|---|
  | Content | write cap + `content.publish` (Admin, CC) |
  | Removals and archives | `content.archiveDelete` (Admin) |
  | Identity + footer + forms config | `settings.general` (Admin, Dev) |
  | Theme + header/intro appearance | `theme.edit` (Admin, Dev) |
  | SEO, redirects | `seo.*` / `redirects.manage` (Admin, SEO) |
  | Page visibility | `maintenance.manage` (Admin, Dev) |
  | Anything | never Sales |

  - Each cell equals what that role can already make live today by saving.
  - §5's "Publish / schedule" row is relabelled **"Publish / schedule content"** (in §5, architecture §3.4 and `LABEL_TO_CAP`), so "Developer … no publish" stays literally true.
  - The savebar and the publish dialog decide eligibility per item. By default everything you may publish is ticked; you can untick items, dependencies are auto-included, and the rest shows as "N waiting for someone who can publish".
- **P-3 What is staged and what is immediate.**
  - **Staged:**
    - pages, sections, services, disciplines, cases, projects + children;
    - testimonials, clients, team, statistics, certifications, sectors, categories, blog, navigation, FAQ;
    - identity + footer settings, theme, `site_appearance`;
    - entity SEO, SEO defaults;
    - redirects: a slug rename and its 301 go live together, and the KV snapshot is rebuilt after apply/rollback;
    - page visibility: KV re-sync after apply/rollback;
    - forms config, template shared text, section appearance.
  - **Immediate:**
    - maintenance (a Pillar-1 kill switch checked before the cache);
    - users, integrations/secrets, technical settings, timezone, `accepting_applications`;
    - leads and all CRM data, job applications;
    - media binaries **and** alt/tags (as in the prototype);
    - Style-Finder content (not public until the quiz ships);
    - help articles, prefs.
- **P-4 One preview stack, owned by REL (R8/R9).**
  - Route `/admin/preview/**`; marker `data-pv-section`; envelope `packages/schemas/previewMessage.ts`.
  - The bridge lives under `src/lib/admin` (an admin-* chunk) and never loads on Tier A pages.
  - E2 consumes it.
- **P-5 Saving.**
  - Content editors use `useEntitySave`. Before switch-on: explicit Save with version/409. After switch-on: draft autosave, 800 ms idle in the page editor (it feeds the preview), and on blur, section switch or ⌘S elsewhere.
  - Draft audit rows are coalesced to at most one per draft per user per 10 min.
  - CRM never autosaves keystrokes: discrete controls send one versioned PATCH each, and forms have an explicit Save.
- **P-6** `app.is_staff()` stays exactly the 4 CMS roles. `app.is_member()` (5 roles) is used only by `audit_insert`. No `is_cms_staff()`.
- **P-7** One people directory, `app.staff_directory()`. CMS staff get all active members. Sales gets only assignable lead workers. It is never exposed to anon.
- **P-8** One harness slice first (F0).
- **P-9** No row is split across two capabilities. `site_appearance` holds header + intro settings (`theme.edit`). Footer settings are columns on `site_profile` (`settings.general` — "identity, footer").
- **P-10 Bundle** (owner O-15). Proposal: the **eager JS graph of each admin route ≤ 300 KB gz**, own caps on lazy chunks (e.g. `admin-rich`), and a total-sum tripwire.
  - Chunking uses rolldown `codeSplitting.groups` (explicit tests, `includeDependenciesRecursively:false`) plus post-build chunk-content tests.
  - Every PR reports its delta; KB means 1,000 B.
  - Projected today: about 290–300 KB summed before CRM, against 223 KB now.
- **P-11** Decisions docs per track (`docs/admin-v2/{ui,releases,crm}.md`) plus one `deviations.md` register holding the TDD coverage table. This avoids same-heading merge conflicts.
- **P-12** The client's copy rules apply to admin copy:
  - plain and warm;
  - no em or en dashes;
  - the brand is never spelled out — it comes from `site_profile` (§1);
  - Arabic content digits are never transformed (round-trip test).
- **P-13** Migrations take the next free number at branch time (0030 is next). `ALTER TYPE app_role ADD VALUE 'sales'` sits alone in its own file. Prod DB pushes and merges are owner-gated: one branch + PR per slice, CI green, Claude never merges.
- **P-14 Grants under both Supabase regimes.** From 2026-10-30, Supabase stops auto-granting new tables in existing projects. Every new table and function therefore gets:
  - `revoke all … from public, anon, authenticated` plus exact grants, **including `service_role`**;
  - postconditions that check what must and must not be granted;
  - `pg_trgm` schema-qualified (`extensions.`);
  - trigger names ordered on purpose (BEFORE triggers fire alphabetically);
  - a tenant predicate in every policy, RESTRICTIVE ones included.
- **P-15 Workers Free-plan limits.** 10 ms CPU and 50 subrequests per request, 100k requests a day. Publish validation, preview SSR, `/_image` and `theme.css` are measured on staging before R14 (owner O-16). Releases are capped at about 60 items (the dialog splits larger ones).

## Track UI — design system, shell, screens (docs/admin-v2/ui.md)

- **Tokens** (AA-checked; `contrast-audit` reads them from `admin.css`):
  - primary `var(--bs-klein)`, hover `var(--bs-cobalt)`;
  - ink/sidebar `#0B0D14`, ground `#F5F6FA`;
  - radii 14/10/8;
  - fixes over the prototype:
    - `--dim2` `#626A7F`;
    - sidebar labels `#919295`;
    - badge text `#067647` / `#B54708` / `#B42318`;
    - control borders and toggle track `#828B9E`;
    - focus `#024CFF` (`#22A9FF` on midnight);
    - chart series and avatar tones ≥ 4.5:1;
  - fonts mirror `global.css`, Almarai 800 included.
- **CSP-safe dynamics.** Widths use data buckets; geometry uses SVG attributes; colours use classes. Drag and preview scale use CSSOM after hydration; icons come from a same-origin sprite. No `style={{}}`, no runtime `<style>`, no `data:`/`blob:` images (each a test).
- **Shell**:
  - a midnight sidebar with icons, counts, an env pill and a user chip;
  - a topbar with crumbs, the ⌘K trigger, a maintenance badge, the bell, the help "?" and View site;
  - a skip link;
  - a **zero-JS popover sidebar below 900px** (under `@supports selector(:popover-open)`, plus a `matchMedia` → `hidePopover` handler);
  - browser floor Chrome/Edge 117, Firefox 129, Safari 17.5.
- **IA** (`nav.ts` stays derived from `ROLE_CAPS`; retired routes 302):

  | Group | Items |
  |---|---|
  | Overview | Dashboard |
  | Content | Pages · Services · Projects · Creative Knowledge · Testimonials · Clients · Team · FAQ · Numbers · Certifications · Media library |
  | CRM | Leads · Contacts · Tasks |
  | Hiring (Admin) | Job applications |
  | Growth | Website stats · Site health · Style-Finder |
  | Appearance | Theme · Header · Footer · Loading screen |
  | Settings | General · SEO · Forms · Notifications · Integrations · Users & roles · Activity log · Backups & versions · CRM settings |

- **Uploads** (U3):
  - images are **re-encoded at upload** through the `IMAGES` binding (long edge about 2560 px, WebP/AVIF, EXIF/GPS stripped) and only the output is stored;
  - up to 25 MB, streamed;
  - byte-sniffed; SVG/GIF refused;
  - bilingual alt required;
  - delivered through `<Picture>` and same-origin `/_image`;
  - required config: `image.remotePatterns` from the build env (the build fails if unset), stored dimensions always passed;
  - required schema changes: anon `media_assets_public_read`, the provider CHECK, the Zod enum and `ImageRef` all widened to `storage`.
- **Screens.** Each screen's list is in the slice table below. Highlights:
  - the dashboard gets per-user layout, owner-set role presets and team notes;
  - General gets typed identity, favicon/manifest, and maintenance copy, auto-off and a staff bypass, all carried in the KV value;
  - SEO gets drawers with EN + AR Google previews;
  - Users gets invites, owner protection and a Security card;
  - the activity log gets filters and a locked-down export;
  - page visibility offers all five modes (U14);
  - GA4 is loaded behind consent;
  - there is a help centre and 2FA.
- **Page editor** (E1–E3, E9–E11):
  - three columns: sections, typed fields prefilled with the built-in copy (F6), and live preview;
  - word-range accents instead of HTML;
  - EN | العربية | Both, with an "Arabic missing: N" cue;
  - SEO and History drawers (history includes a page-scoped restore);
  - section appearance variants;
  - Text/Gallery/Video sections;
  - New page;
  - template editors with editable shared text.
- **Appearance** (E4–E7, E12–E13):
  - a theme with a contrast gate, delivered as `/styles/theme.css?v=` only when not the default;
  - motion settings that can only *reduce* motion;
  - shapes and type tokens;
  - a curated self-hosted font catalogue;
  - header options in buckets (tint has a minimum when transparent);
  - footer columns, templated copyright, legal links locked;
  - loading styles: logo/video/black/light/bar/text, ≤ 1.5 s, lhci re-gate.

## Track REL — site-wide releases (docs/admin-v2/releases.md)

- **Tables**:
  - `content_drafts`: one per entity; payload untrusted and re-parsed with Zod; `base` + `base_version` for column-level 3-way conflicts.
  - `content_releases`: per-tenant `number` assigned when it goes live; service-role writes only.
  - `content_release_items`: append-only before/after images. They are captured by AFTER triggers, which also cover **portfolio child cascades** and **out-of-band writes as system items**, so Restore stays correct.
  - `app.release_entities` registry.
  - `content_versions`: gains `release_id`, full coverage, and loses staff INSERT.
- **The switch-on flag** is not writable by any API role: it lives in `app.release_tenants`, which is read by a definer function.
- **Write path**:
  - `resource.ts`, `singleton.ts` and `entity-seo` get a staged branch behind `releasesEnabled()`;
  - reads overlay live + draft;
  - `accepting_applications` gets its own immediate endpoint.
- **Publish**:
  - The Worker runs `assertCap` per item plus `liveRecheck`, and validates on the post-release state (Zod, `assertPublishable`, guards, redirect rules, dependencies).
  - `public.apply_release` (service-role only, SECURITY INVOKER) switches to the publisher's live profile. Verified: `SET LOCAL ROLE authenticated` is allowed inside an invoker function, every RLS helper reads the injected claims, and the txid token can't be forged.
  - It runs one fail-fast transaction under a per-tenant advisory lock (per-item exception blocks only in dry runs), with the tenant taken from the live profile and the audit row written in the same transaction.
  - After commit: purge, KV syncs, sitemap/llms tags.
- **Guard**: staged tables refuse staff JWT writes outside a release, which closes the PostgREST bypass of Worker validation. There is no `pg_trigger_depth` exemption.
- **Purge seam** `src/lib/http/purge.ts`:
  - tied to the cache layer actually used (zone API, or `ctx.cache.purge` for Workers Cache);
  - a **CI check refuses enabling Workers Cache or Astro's cache provider without the matching backend**, and maintenance-on purges everything when Workers Cache is on (cached hits skip the Worker);
  - `SECTION_READS` derives page tags from the sections actually rendered;
  - `tierATags` keeps the ALWAYS, route and locale tags, and a test fails above 30.
- **Scheduling** moves to releases. The minute cron fires a release as its scheduler, re-checked live. Legacy scheduled rows convert at switch-on.
- **Versions, history, rollback**:
  - a timeline;
  - per-item and **page-scoped** history;
  - "Restore vN" stages the as-of state as drafts, which are previewed and then published as a rollback.
- **Preview**:
  - Public loaders read through `contentClient()`, a request-scoped seam that defaults to anon and is resolved synchronously when a query is built.
  - The overlay emulates only the operations the loaders use: eq, in, contains, order, limit, maybeSingle, and embeds up to 3 levels. Unknown operations throw.
  - The dataset is paged with `range()` (Supabase `max_rows` is 1000).
  - A **fail-closed ribbon** appears if a preview render touched `anonClient` or served zero overlay reads.
  - The parity e2e is mandatory on every Tier A route.
  - The layout has no telemetry, consent banner or form submits; it sends noindex.
  - `frame-src 'self'` applies to `/admin/**` only.
- **Rollout**:
  1. Expand (flag off = today's behaviour; the CI seed keeps it off; the e2e workflow enables it after seeding).
  2. Staging rehearsal.
  3. Production switch-on: about a 15-minute freeze; `app.enable_releases` writes baseline v1.
  4. Contract after one stable cycle.

## Track CRM — core and the Sales role (docs/admin-v2/crm.md)

- **Leads v2**:
  - `lead_stages`: editable, CSP-safe colours via generated classes with an AA gate and named presets;
  - `is_spam` with a working spam purge: a plain BEFORE UPDATE comparing OLD and NEW, and un-spam restores the horizon;
  - columns for assignee, value, star, read, tags, score + signals, first response, won, last contact, HMAC blind indexes (a labelled `LEAD_PII_ENC_KEY` derivation), source/channel, `version` and a friendly per-tenant `lead_number`;
  - `lead_notes` and `lead_events`;
  - a RESTRICTIVE live check `app.live_role()` on every PII table.
- **PII at the DB layer**:
  - SELECT on `leads` is column-scoped: no `internal_notes`, `timeline_band`, `ip_inet`, `score_signals` or `*_hmac`;
  - gated columns and **notes** are read only through the audited server path (service role after `assertCap` + `liveRecheck` + a fail-closed audit), so "one lead at a time" holds at PostgREST too;
  - `timeline_band` is encrypted.
- **Ingest**:
  - the Worker generates the lead id;
  - the service-role RPC falls back to today's insert only on PGRST202, 42883 or transport errors, and 23505 counts as success;
  - a contact is upserted by blind index; a phone match links and flags it ("Linked by phone, please check");
  - a company is found or created by non-freemail domain or normalised name.
- **Contacts, companies, merge, tasks, settings** follow the design, plus:
  - contacts in ⌘K for `crm.contacts` holders (name + company, POST lookup); leads never;
  - CSV import with per-row lawful-basis attestation;
  - contact files (private bucket, audited download).
- **Capabilities** (32 → 37; one SQL helper per capability):

  | Capability | Admin | CC | SEO | Dev | Sales |
  |---|:-:|:-:|:-:|:-:|:-:|
  | `leads.manage` | ✅ | ❌ | ❌ | ✅ | ✅ |
  | `leads.pii` (one at a time, audited) | ✅ | ❌ | ❌ | ✅ | ✅ (O-6) |
  | `crm.contacts`, `crm.tasks` | ✅ | ❌ | ❌ | ❌ (O-7) | ✅ |
  | `crm.settings`, `crm.erase`, `crm.import` | ✅ | ❌ | ❌ | ❌ | ❌ |
  | `analytics.read` | ✅ | ✅ | ✅ | ✅ | ✅ (prototype parity) |
  | `export.csv`, `siteHealth.view` | ✅ | ❌ | ❌ | ✅ | ❌ |

- **Sales is the first non-staff `authenticated` principal**, so:
  - a **catalog-driven pgTAP** test asserts Sales sees no more rows or columns than anon outside the CRM;
  - a RESTRICTIVE non-staff block covers testimonial consent columns;
  - "not `is_staff()`" trusted-context checks are replaced by no-role-claim checks.

## Reflect and be reflected (public output → tags → gates)

| Admin screen | Feeds | Purges | Re-run |
|---|---|---|---|
| Page editor + section types + custom pages | `getPageComposition` → SectionRenderer; `[slug]` route | `page:<slug>` + `SECTION_READS` tags | lhci per route (+`/ar`), hero-intro/layout-shift, axe, served-html |
| Services, Projects | `/services/[slug]`, case studies, cards, facets, JSON-LD | entity tags, `services:all`, `portfolio:all`, sitemap/llms | lhci entity routes, media-bytes, JSON-LD |
| Collections / FAQ | testimonials, marquee, leadership, StatBand / FAQ + FAQPage | `testimonials:all` … `faq:all` | JSON-LD EN+AR, axe |
| Theme / fonts / Header / Footer / Loading / section appearance | `theme.css`, SiteHeader, SiteFooter, Hero intro, section classes | `site:chrome`, `nav:all`, `site:identity` | contrast gate, layout-shift, hero-intro, lhci themed run, visual baselines |
| General / SEO / Forms | identity, ContactChannels, socials, JSON-LD, SeoHead, form copy | `site:identity`, entity and route tags | served-html, seo-ci, form e2e |
| Page visibility / Maintenance | middleware 404/redirect/password gate / 503 before the cache | KV snapshot; sitemap/llms | visibility + maintenance e2e |
| Media alt/replace | every `<Picture>` of a media row | `media:all` + usage tags | lhci (LCP posters), axe |

## Slice sequence (one branch + PR each; the design ids are in brackets)

**Phase 0 — Foundation**

| # | Slice | Depends |
|---|---|---|
| F0 | Harness + CI: local auth hook, CI-only staff per role, `loginAs`, per-role admin sweep (no console errors or overflow, from the client's `adfull.mjs`), admin CSP (server HTML) + axe baselines, `login.astro` grandfathered until F7; commit `docs/admin-v2/*` [R0, AV-01] | H4 |
| F1 | Design system, verbatim-first from `app.css`, with the test-pin edits listed per file — **the whole admin takes the new look** [AV-02] | F0 |
| F2 | Shell + IA + retired-route stubs + counts [AV-03] | F1 |
| F3 | Overlays on `<dialog>`, toasts, ⌘K + `/api/admin/search` [AV-04] | F2 |
| F4 | Component kit, rolldown chunk groups + chunk tests, bundle budget definition (O-15) [AV-07] | F1 |
| F5 | Field kit v2 + `useEntitySave` + Arabic-digit round-trip test [AV-08] | F4 |
| F6 | Built-in section copy as shared data (byte-identical public HTML) [AV-23] | — |
| F7 | Sign-in v2, remember-me, forgot/reset; login stops downloading admin-ui (≈166 KB) [AV-06] | F1 |
| F8 | Prefs, `staff_directory`, notifications bell, account (profile, password) [AV-05] | F3 |

**Phase 1 — Screens on the kit (live save until R14)**

| # | Slice | Depends |
|---|---|---|
| U1 | Dashboard + per-user layout + quick actions + owner role presets + team notes [AV-09+] | F8, F4 |
| U2 | Website stats v1 + Site health v1 + `rollup_daily_vitals` [AV-10] | F4 |
| U3 | Uploads pipeline (A5, re-encode, EXIF strip, 25 MB, schema widening) [AV-11+] | F0, H3 |
| U4 | Media library + picker with upload [AV-12] | F5, U3 |
| U5 | Services area (value cards ≤ 4, problems ≤ 5, after checking rows) [AV-14] | F5, U4 |
| U6 | Projects area [AV-15] | F5, U4 |
| U7 | Collections + `faq_items` (delta seed before `CONTACT_FAQ` goes; e2e keeps FAQ + JSON-LD) [AV-16] | F5 |
| U8 | Creative Knowledge, Style-Finder, Job applications on the kit [AV-17] | F5 |
| U9 | General: typed identity, favicon/manifest, footer columns, timezone (closed list); maintenance with bilingual copy, background, contact buttons, "Back on" auto-off, show date, a staff-bypass toggle (fail-closed), IP allowlist — all in the KV value; Retry-After from "Back on" [AV-18+] | F5 |
| U10 | SEO [AV-19] | F5 |
| U11 | Integrations (typed) + notification prefs [AV-20] | F8, F5 |
| U12 | Users & roles: emails, invites (resend/cancel), **owner protection**, Security card (session ≤ 7 days, invite domain, invite message; "Require 2FA" arrives with U17), read-only matrix [AV-21+] | F8 |
| U13 | Activity log: person/date/kind filters, names, plain language, export under the lockdown (`export.csv` holders; the §5 export row label is extended, no new cap) [AV-22+] | F8, F4 |
| U14 | Page visibility (own table, Admin+Dev): public / hidden (404 or redirect to any page) / link only / **password** (pre-cache gate, private no-store, bcrypt via service RPC, signed per-page cookie, limiter) / hide-from–show-on dates; template-wide hide; KV snapshot; nav/sitemap/llms exclusion [AV-13+] | F4 |
| U15 | GA4 behind `hasConsent('analytics')`: same-origin loader, CSP sources only while an id is set (Report-Only cycle), GA tab via the Data API | F5, U11 |
| U16 | Help centre: `help_articles` (typed blocks, no HTML), the "?" drawer with search, per-screen guides filtered by caps; articles rewritten for built features | F3 |
| U17 | 2FA: TOTP enrolment in Account, "Require 2FA" (aal2 in `resolveAuthContext`), Admin "Reset 2FA" (audited) | F8, U12 |

**Phase 2 — Releases** (backend lane starts after F0)

| # | Slice | Depends |
|---|---|---|
| R1 | Ledger schema, registry, protected flag table, snapshot coverage, `content_versions` hardening (inert; P-14 grants) | F0 |
| R2 | Registry, caps and overlay core (TS) | R1 |
| R3 | Staged writes in the kernel (behind the flag) | R2 |
| R4 | `apply_release` (fail-fast, ~60-item cap, tenant from profile) + capture | R1 |
| R5 | Guard (no depth exemption), cascade + out-of-band capture, `media_usage` v4, attention v4 | R4 |
| R6 | Publish + validate endpoints | R3, R4 |
| R7 | Purge seam (cache-layer aware + CI check), `SECTION_READS`, `media:all` on 8 routes, minute cron | R2, R6 |
| R8 | Preview data seam (narrowed overlay, `range()` paging, fail-closed ribbon) | R2 |
| R9 | Preview route, layout mode, bridge (in `src/lib/admin`), CSP `frame-src` | R8 |
| R10 | Versions, history (+ page-scoped restore), Restore vN | R6, R9, R5 |
| R11 | Scheduled releases + enable/disable functions | R6, R7, R5 |
| R12 | Release UX I: savebar, review, publish dialog (per-item eligibility), conflicts, badges, draft autosave | R6, R7, R9, F5 |
| R13 | Release UX II: Backups & versions page, history drawer, dashboard publish card | R10, R11, R12 |
| R14 | **Switch-on**: amendments, runbook, e2e in release mode, static write-path test, CPU measurements (O-16) | R3–R13 + staged U screens |
| R17 | Scheduled content backups: daily export-backup JSON to R2 (keep 30), "Back up now", download under the lockdown, restore as drafts through releases | R10, R14 |

**Phase 3 — Page editing & appearance** (after R9 + R12)

| # | Slice | Depends |
|---|---|---|
| E1 | Pages list + page editor core [AV-25] | R12, F6, U10 |
| E2 | Live preview column [AV-26] | E1, R9 |
| E3 | Template editors + editable shared text (`template_copy`, staged, AR required, code defaults) [AV-31+] | E2, U5, U6 |
| E4 | Theme v1 + `theme.css` + contrast gate + motion-reducing settings [AV-27+] | R12, E2 |
| E5 | Header + `site_appearance` (bucketed options, as in Track UI) [AV-28+] | R12, E2 |
| E6 | Footer [AV-29] | E5, U9 |
| E7 | Loading screen (all styles incl. bar and tagline; lhci re-gate) [AV-30+] | E5 |
| E8 | Forms config: labels, visible/required for optional fields, order, button text, budget labels, consent-copy versions, captcha toggle (O-19); server validation follows the config | R12, U9 |
| E9 | Section appearance: background/spacing/reveal variants, editable anchors (slug rules, unique per page); contrast pairs + visual baselines | E1 |
| E10 | New section types: Text block, Gallery, Video (showreel window, zero bytes before intersection) | E1 |
| E11 | Custom pages: New page + Tier A `[slug]` and `/ar/[slug]` routes with SeoHead, JSON-LD, sitemap, hreflang, tags [AV-33] | E10 |
| E12 | Theme v2: radius, button style, heading weight/case tokens + visual regression [AV-32] | E4 |
| E13 | Font catalogue: curated self-hosted families (pre-subset woff2 + per-weight/per-script metric fallbacks, ≤ 180 KB/route) | E12 |

**Phase 4 — CRM core + Sales** (lane starts after F4/F5)

| # | Slice | Depends |
|---|---|---|
| C1 | Leads v2 schema (all P-14 + DB-layer PII rules, spam, lead_number, ingest RPC) | F0, H1, H2 |
| C2 | Leads read API (query/board/summary, audited reveal, notes path, directory) | C1 |
| C3 | Leads write API (versioned PATCH, bulk with per-lead audit, manual add, erase, export filters) | C2 |
| C4 | Leads UI (list + KPIs, board with keyboard "Move to…", detail, add drawer) | C3, F5 |
| C5 | Contacts schema + ingest linking + phone link-and-flag + retention + person erase (**merge gated on O-11**) | C3 |
| C6 | Contacts API | C5 |
| C7 | Contacts UI + contacts in ⌘K | C6, C4 |
| C8 | Tasks | C6, F5 |
| C9 | CRM settings (stages with a colour picker + AA gate, scoring, custom fields, SLA, assignment) | C4, C7 |
| C10 | **Sales role** (enum file alone, then helpers; `ROLE_CAPS`, §5, architecture §3.4 parsed by CI; catalog-driven exposure test; `analytics.read`) | C4, C7, C8, C9 |
| C11 | Companies + find-or-create at ingest | C7, C10 |
| C12 | Merge duplicates | C7, C10 |
| C13 | Lead attribution (consent-gated) + privacy notice — **blocked on O-11** | C2 |
| C14 | Contract (drop legacy status / internal_notes / ip_inet) | C4, C10 |
| C15 | CSV import (`crm.import`, Admin): server parse, ≤ 5,000 rows / 2 MB, per-row lawful basis, blind-index dedupe, rate-limited, audited counts | C7 |
| C16 | Contact files (private bucket, byte-sniffed, audited download) | C7 |

**Phase 5 — Growth within the standard**

| # | Slice | Depends |
|---|---|---|
| G1 | Stats v2 on already-consented data: sessions, events (`cta_click`, `service_interest`), views→inquiry funnel, busiest hours (Riyadh), goals, realtime from a 1-minute rollup | U2 |
| G2 | Health v2: uptime from the external monitor's API (O-20), SSL/domain expiry via RDAP in the daily cron, failing checks in the bell | U2, F8 |

**Phase 6 — Closure**

| # | Slice | Depends |
|---|---|---|
| Z1 | Admin visual baselines (1440/390), full per-role axe matrix with dialogs open, docs + TDD coverage closure [AV-34] | E1, E4, E5, U12, U13, C10 |
| R15 | Release contract | R14 + one stable cycle |
| R16 | PDPL history redaction — **legal-gated (O-12)** | R4, R14 |

**Later** (each its own approval; gated by legal or A1):
- L5: tracking that needs PDPL sign-off (referrer, UTM, device, country, a persistent visitor id).
- L6: CRM comms — inbox (email + WhatsApp), templates, segments, campaigns, automations, CRM reports, export & audiences incl. ad pixels, Get connected wizards, marketing-consent opt-ins + unsubscribe, notification emails/auto-reply, 7-day invites via our own transactional email.
- L7: Arabic admin.
- L8: link crawler (CPU/plan).
- L9: Cloudflare zone + Tier A edge cache (KAN-20).

**About 80 PRs.**
- Do-now fixes and parallelism: H1–H4 now. After Phase 0, three lanes run in parallel: U, R and C.
- Phase 3 waits on R12; G and Z come last.
- The client sees the new look from F1, and the CRM core from C4.

## Design ids and program slices

The designs number their slices by track (AV, R, CRM). The program reorders and merges them;
the bracketed ids in the slice tables above are the design slices each program slice builds.

| Design | Program |
|---|---|
| R0 (release harness) and AV-01 (UI harness) | F0, one harness for both tracks |
| AV-02 to AV-08 | F1 (AV-02), F2 (AV-03), F3 (AV-04), F8 (AV-05), F7 (AV-06), F4 (AV-07), F5 (AV-08) |
| AV-09 to AV-23 | U1 (AV-09), U2 (AV-10), U3 (AV-11), U4 (AV-12), U14 (AV-13), U5 (AV-14), U6 (AV-15), U7 (AV-16), U8 (AV-17), U9 (AV-18), U10 (AV-19), U11 (AV-20), U12 (AV-21), U13 (AV-22), F6 (AV-23) |
| AV-24 (release UX) | R12 and R13: REL owns one savebar, publish dialog, history and versions screen |
| AV-25 to AV-33 | E1 (AV-25), E2 (AV-26, on the R9 preview route), E4 (AV-27), E5 (AV-28), E6 (AV-29), E7 (AV-30), E3 (AV-31), E12 (AV-32), E11 (AV-33) |
| AV-34 | Z1 |
| R1 to R16 | R1 to R16, same numbers; R17 (scheduled backups) is new |
| CRM-1 to CRM-14 | C1 to C14, same numbers; C15 (CSV import) and C16 (contact files) are new |
| (none) | U15 (GA4), U16 (help centre), U17 (2FA), E8 to E10, E13, G1, G2: added under A6 or by the verification |

## Remaining deviations

The register of every place the build deliberately differs from the prototype, with the
standard rule or owner decision behind each, is [deviations.md](deviations.md), together
with the client's TDD checked row by row. O-13 asks the owner to approve it.

## Standard amendments (each in the slice that changes the rule)

- **CLAUDE.md**:
  - §1(4): 5 roles.
  - §2:
    - the admin look;
    - publish = release;
    - the bundle definition (O-15);
    - Cache-Tags `site:chrome`, `faq:all`, `SECTION_READS`, `media:all`;
    - Workers Cache is forbidden without the matching purge backend.
  - §3:
    - releases + guard;
    - the `apply_release` exception to "set_config claim injection only in pgTAP" (§9);
    - `frame-src 'self'` on /admin only;
    - the preview bridge;
    - page visibility as a pre-cache check;
    - maintenance staff bypass (fail-closed);
    - lead-PII bullets (column-scoped SELECT, notes path, live check, fail-closed reveal);
    - correct the `leads_safe` grant sentence;
    - the 2FA policy.
  - §5:
    - Sales column;
    - CRM caps;
    - "Publish / schedule content" relabel;
    - the derived release matrix;
    - General settings "identity, footer, forms";
    - export row label extended to "Leads / analytics / activity — export CSV";
    - Sales `analytics.read`.
  - §6: size-limit actually in CI; KB = 1,000 B.
  - §7: CSP line; export lockdown extended (activity, contacts).
  - §8:
    - drafts/releases/versioning;
    - registry contract;
    - registry/ledger shape exceptions;
    - P-14 grants;
    - media provider `storage`;
    - theme and font delivery;
    - new tables;
    - admin file conventions.
  - §9: release/CRM/Sales/catalog-exposure test rows.
  - §10: minute cron, purge observability, notifications as a derived feed.
- **docs/architecture.md**:
  - §1.4/§1.6: purge-by-tag on all plans; "Enterprise-only" is stale.
  - §2.4/§2.5/§2.11.
  - §3.4: in the §5 format and parsed by CI.
  - §4.3: the bridge.
  - §8.3: horizons.
- **Other docs**:
  - retention.md: contacts, tasks, notes, spam, privileged_ops.
  - hero-intro.md: buckets and styles.
  - fonts.md: admin mirror + catalogue.
  - launch-runbook.md:
    - bucket;
    - SMTP;
    - releases enable/disable + freeze;
    - purge token;
    - Sales rollout;
    - pg_cron RLS check;
    - R2 backups;
    - the owner-protection marker.

## Tests and gates (every slice ships its own, §9)

- **pgTAP** per new table/RPC over admin, content_creator, seo, developer, sales, anon and other_tenant, plus stale tokens.
  - **Releases**: apply impersonation matrix, guard, protected flag, schedule, capture incl. cascades and out-of-band writes, dry run, token catalog assertion.
  - **CRM**: leads column grants, notes path, pipeline, contacts, merge, retention actually deleting, import.
  - **Sales**: catalog-driven exposure.
  - **UI tables**: prefs, help, faq, site_appearance, page_visibility, media provider and anon read, template_copy.
  - Grants postconditions hold under both privilege regimes.
- **Authz**:
  - `endpoints.spec` rows for every new route (it iterates `ROLES`);
  - `matrix.spec`: 5 roles / 37 caps, also parsing architecture §3.4;
  - `releaseMatrix.spec`;
  - `sqlHelpers.spec`.
- **Unit**:
  - overlay, conflicts, tags closure, purge backends;
  - preview client + visibility; bridge envelope;
  - blind index, scoring, .ics, Riyadh grouping;
  - theme gate properties;
  - media sniff + re-encode fixtures; `/_image` guard;
  - Arabic digits round trip;
  - admin static rules: no style props, no runtime `<style>`, no admin `<script>`, no colour literals, sprite and font-face parity, nav hrefs resolve;
  - chunk contents.
- **E2E (EN+AR)**:
  - per-role admin sweep;
  - releases: draft → preview → publish → public, rollback, conflict, schedule;
  - preview parity (every Tier A route) and isolation;
  - CRM round trip and Sales negative paths;
  - uploads;
  - visibility modes incl. password and dates;
  - maintenance bypass (fails closed);
  - FAQ → JSON-LD;
  - theme publish with zero CSP violations;
  - header presets with no layout shift;
  - keyboard journeys.
- **Gates that stay green**: lhci (+ a themed run), size-limit (now in CI), layout-shift, hero-intro, media-bytes, served-html, seo-ci/JSON-LD, axe (admin routes added), CSP, contrast audit.

## Verification (end to end)

1. **Per slice**: CI green; the size delta in the PR; a manual run via the `run` skill on the changed screens (EN + AR, each role), with screenshots side by side against the prototype.
2. **Before R14**: a staging rehearsal with releases on, the full e2e suite in release mode, CPU measured (O-16), and the owner walking the prototype's flows.
3. **TDD §18 acceptance, mapped**:

   | Acceptance item | Slice | Status |
   |---|---|---|
   | Every route for every role: no errors, no overflow, sidebar per role | F0/Z1 | ✓ per-role sessions replace View as; https, not `file://` |
   | Homepage headline visible after Publish, not before | R14 | ✓ |
   | Hidden page returns 404 and leaves the menu | U14 | ✓ incl. sitemap/llms and KV re-sync after rollback |
   | 503 for visitors, signed-in admin passes | U9 | ✓ fail-closed |
   | Sales cannot open users by URL, API or PostgREST | C10 | ✓ |
   | A deleted project comes back | R10 | ✓ Restore vN, with portfolio children |
   | A form submission is a lead within 5 s | C1 | ✓ bell notification; email delivery is L6 |
   | Template editor + preview | E2/E3 | ✓ after the autosave reload |
   | Public pages clean | R9 | ✓ inverted: the bridge must *not* be on public pages |
   | Campaign / WhatsApp 24 h / automation / Get connected | L6 | — |

## Owner items

- **Provisioning**
  - **O-1** Supabase Storage bucket `media` (staging + prod).
  - **O-2** SMTP for Supabase Auth (invites, reset), with SPF/DKIM.
  - **O-3** Cloudflare zone + a cache-purge-only token (KAN-20). Until then purges do nothing and pages stay fresh.
  - **O-17** An R2 bucket for scheduled content backups (R17).
  - **O-18** A GA4 property + Data API service account (U15).
  - **O-19** A captcha provider for forms. Turnstile is recommended: free and Cloudflare-native.
  - **O-20** An external uptime monitor API key (G2).
  - **O-21** The font families for the catalogue, with web licences (E13).
- **Release decisions**
  - **O-4** Approve the release semantics (P-2/P-3): per-area publish, all-ticked default with opt-out, optional note (≤ 280 characters), per-item schedule replaced by release scheduling.
  - **O-5** The switch-on window (about a 15-minute freeze), the operator, and a fallback scheduler for legacy scheduled rows.
- **CRM decisions**
  - **O-6** Sales sees budget/timeline one lead at a time, audited and rate-limited (recommended).
  - **O-7** Developer gets no CRM contacts/tasks (recommended) and keeps leads for now.
  - **O-8** Legacy "done" leads backfill to Lost (recommended).
  - **O-9** Rate limits (reveals 60/h per user, 300/h per tenant; erasures 20/h per user, 50/h per tenant); Admin-only erasure; Manual assignment by default; the Tasks badge counts my overdue tasks.
  - **O-10** Stage presets and tones; time zone Asia/Riyadh.
- **Legal**
  - **O-11** Approve the privacy-notice updates (contacts, notes/tasks, retention from last activity, attribution, backups keeping erased data ≤ 28 days, the DSAR answer within 30 days). This gates merging **C5** and **C13**.
  - **O-12** Approve history redaction (R16) and a retention period for release history.
- **Product confirmations**
  - **O-13** Approve the remaining-deviations register, including the header's always-visible language switch.
  - **O-14** The logo stays a code asset (it is the home LCP element); who owns the FAQ content; "Keep me signed in" on by default; Content Creator keeps the intro on/off switch while style and timing go to `theme.edit`.
  - **O-15** Admin bundle budget: the eager graph per admin route ≤ 300 KB gz (recommended), or keep the 300 KB sum, or raise the number.
  - **O-22** Invites expire in ≤ 24 h (Supabase limit), with Resend, instead of 7 days until L6.
- **Ops checks**
  - **O-16** Workers plan: measure CPU and subrequests for publish/validate, preview SSR, `/_image` and `theme.css` on staging. The Free plan allows 10 ms/request. Workers Paid ($5/mo) may be needed.
  - **O-23** Production checks: Postgres major ≥ 15, leads grants (H2), and whether the pg_cron role bypasses RLS (retention).

## Risks

- **Supabase grants regime change (2026-10-30)**: CI may pass under the old regime while production returns 42501. Mitigated by P-14 postconditions under both regimes.
- **Free-plan limits**: Workers CPU and subrequests (O-16); the Images quota (H3 + re-encoding + allow-list); Supabase storage (1 GB shared with the CV bucket) and egress (5 GB).
- **Preview fidelity**: AsyncLocalStorage is verified (Astro uses the same pattern). The narrowed emulator still needs the parity e2e on every route.
- **Workers Cache misconfiguration**: it would cache Tier A HTML for a year and skip the maintenance check. A CI check guards it (R7).
- **Program size**: about 80 PRs. Mitigated by three lanes, a feature flag, and a `main` that stays shippable.
- **Sales as the first non-staff authenticated principal**: guarded by the catalog-driven exposure test.
- **Editors expecting "Save = live"** after switch-on: the savebar, badges, help guides and the freeze briefing.
- **Legal gates** O-11/O-12 block C5, C13 and R16. Everything else proceeds.

## Verification findings (adversarial pass, 2026-10-03)

| Area | Verified | Refuted or partial → applied |
|---|---|---|
| Releases | `SET LOCAL ROLE` inside an invoker function; claim-reading RLS helpers; unforgeable txid token; AsyncLocalStorage in workerd (Astro uses it); purge-by-tag on Free (5/min); nothing caches Tier A today | Flag writable by staff → protected table. CI seed would break pgTAP → enable only in e2e. §9/§8/§5 conflicts → amendments + relabel. Visibility endpoint missed → own table. Depth exemption removed. Cascades not captured → child capture + system items. Subtransaction overflow → fail-fast + cap. `max_rows` 1000 → `range()`. Workers Cache on workers.dev → cache-layer-aware purge + CI check. Bridge chunk → `src/lib/admin`. |
| CRM | D1, D2, D4, D5, D6, D8, D9 real; enum-alone migration correct; composite FKs on PG15; `live_role()` paths correct; `is_staff()` stays 4 roles | Grants unsafe under both regimes → P-14. "One lead at a time" false at PostgREST → column-scoped SELECT + audited notes path. Spam trigger wouldn't fire for legacy writes → plain BEFORE UPDATE. Ingest fallback could duplicate → Worker id + idempotent fallback. Sales reads authenticated-granted public columns → catalog test + RESTRICTIVE block. Tenant predicate missing in RESTRICTIVE policies → added. Contacts horizon → C5 gated on O-11. Sales stats → granted. |
| UI | Storage images work via `/_image` (remotePatterns + explicit dims); bundle baseline 223 KB; popover/@starting-style fine; contrast values pass; `media:all` gap real | Storage hidden from anon by policy/CHECK/enum → widened. 5,000/month quota + arbitrary params → H3 + re-encode. EXIF public → stripped. Bundle unenforced → H4. Projection optimistic → P-10. Chunking pulls deps → rolldown groups + tests. Test pins break → listed per slice. `app.css` not verbatim-safe → verbatim-first with scoping. Publish rule wrong → P-2. `page_sections.label` is public → accepted. |
| TDD coverage | 59 covered, 20 justified deviations, 13 consistently deferred | 25 convenience deviations → built under A6. 10 missing → added: help centre, owner protection, quick-action presets, re-encoding, company find-or-create, page-scoped restore, Arabic-digit test, captcha (O-19). 7-day invites → O-22. `Retry-After` was already shipped. |

## As built

Each slice PR adds a line here when its implementation departs from the design it builds,
so the designs stay readable as the reasoning and this list stays the truth.

| Slice | PR | Departure from the design, and why |
|---|---|---|
| F0 | #34 | One `admin-setup` project and one `admin` project with a `describe` per role (`test.use({ storageState })`) instead of a project per role: one spec covers every role and the role shows in each test title. Staff accounts are created inside the setup (`tests/admin/staff.ts`), not by a separate script, and guarded by a **loopback** Supabase URL and preview rather than `app.deployment`, which no API role can read (0016) and which would not exclude staging. One visit per screen runs the sweep, CSP and axe checks together (`tests/admin/sweep.e2e.ts`) instead of three suites. The admin capture lives in `tests/admin/capture.e2e.ts` because it needs the saved sessions. No axe baseline: the first run found zero violations on every admin screen, so the admin is held to zero like the public routes. That run found two live defects, fixed in F0: Tiptap's runtime `<style>` (refused by the CSP on every editor screen; `injectCSS: false`, its rules moved to admin.css) and the header search failing on Team & authors and Certifications (ilike on a jsonb column). |
| F1 | #35 | The sidebar stays in the page flow, full height by stretch: fixed or sticky comes with F2's shell (a sticky 100vh sidebar also made full-page captures read as a short sidebar). Grid modifiers (`.grid--2/--3/...` on container queries) move to F4, where the first layout needs them: no CSS ships without markup to check it against. The prototype's card anatomy (`card__h/__b/__f`) is not introduced: a card's first `.card-title` renders as the header band and `.card:has(> .stat)` as the KPI (label above the figure). Badges gain `data-tone`; `data-status` maps the lifecycle (published ok, draft warn, scheduled sky, archived gray), and the three islands that borrowed lifecycle states for alarms now use tones (over budget and locked err, not virus-scanned warn, you klein). Inputs keep an outline focus and the `--ad-control` edge rather than the prototype's shadow ring and 1.36:1 line. The contrast gate parses admin.css's token block instead of a copied palette, and the dormant dark palette is deleted. The prototype has 77 icons, not about 78. Sign-in keeps its layout until F7. |
| F2 | #37 | Built on today's routes only. A screen the prototype folds into an area (Disciplines, Case studies, Sectors, Categories, Sections, Search analytics, System logs, Maintenance, Redirects, Style-Finder's Styles and Results) is a **tab** in its area's page head and lights the area's link (`match`); the retired-route redirects arrive with the slices that build their replacements, so no link points at a page that does not exist yet. FAQ, Header, Footer, Loading screen, Forms, Notifications and Backups join the menu with their slices; the navigation editor sits under Appearance as "Menus" until E5's Header. No migration: the environment pill (`admin_environment()` over `app.deployment`) waits for the first slice that ships one. The topbar has no bell (F8), help (U16) or ⌘K hint (F3) yet. The account menu (with Sign out) moves to a `<details>` user chip at the sidebar foot until F8's account drawer. Counts: new leads and new applications; Site health's open-issues count waits for a definition. The sidebar column runs the full page height and its inner block sticks, rather than a fixed shell with internal scrolling. |
| F3 | #39 | The generic Modal and Drawer and the `[data-confirm]` enhancer for server forms move to F4 with their first screens (no kit without a consumer); the palette is its own native `<dialog>`. `confirm.ts` needed no change (already a native dialog with Cancel first, restyled in F1). The palette search's jsonb fix shipped in F0. Quick actions open the existing create routes (`/admin/services/new`), so no intent parameters were needed. The shortcut hint renders "Ctrl K" and reads "⌘K" on a Mac after hydration. Toasts get the prototype's icon (check or info, from the sprite) in place of F1's dot. The bare "/" shortcut is dropped (WCAG 2.1.4, Level A: a one-character shortcut must be switchable off or remappable); ⌘/Ctrl+K and the trigger remain. |
| F4a | (this PR) | F4 is split. **F4a** is the bundle plan: priority-ordered `codeSplitting` groups, the rich-text editor lazy, a per-screen eager-graph gate (`scripts/admin-bundle.mjs`, run by `npm run size`). Measured: every admin screen 225.5 → 103.9 KB gz eager, the sign-in script 168.4 → 2.2 KB, the editor 122.2 KB on demand. Its first run caught Vite's preload helper captured into `admin-ui` and imported by the public RUM script, now a neutral chunk. The size-limit sum stays the tripwire (O-15 decides whether the per-screen measure replaces it). The kit's primitives (Kpi, charts, DataTable, Sortable…) land with their first screens rather than ahead of them, the rule F1 and F3 followed: charts and KPIs with Website stats (U2), DataTable and Sortable with the first list that needs them. |
