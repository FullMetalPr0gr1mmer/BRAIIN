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
| [migrations.md](migrations.md) | The migration ledger: what production has applied, the numbers reserved per wave, the rules, and how a migration reaches production |
| [as-built/](as-built/) | One file per merged slice: where it departs from its design, and why (index under "As built") |

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
- **P-13** Migrations take the number reserved for them in [migrations.md](migrations.md), per wave in planned merge order. `ALTER TYPE app_role ADD VALUE 'sales'` sits alone in its own file. Prod DB pushes and merges are owner-gated: one branch + PR per slice, CI green, Claude never merges.
- **P-14 Grants under both Supabase regimes.** From 2026-10-30, Supabase stops auto-granting new tables in existing projects. Every new table and function therefore gets:
  - `revoke all … from public, anon, authenticated` plus exact grants, **including `service_role`**;
  - postconditions that check what must and must not be granted;
  - `pg_trgm` schema-qualified (`extensions.`);
  - trigger names ordered on purpose (BEFORE triggers fire alphabetically);
  - a tenant predicate in every policy, RESTRICTIVE ones included.
- **P-15 Workers Free-plan limits.** 10 ms CPU and 50 subrequests per request, 100k requests a day. Publish validation, preview SSR, `/_image` and `theme.css` are measured on staging before R14 (owner O-16), and so is the lead CSV export at its cap (80 leads with contact details, C3). Releases are capped at about 60 items (the dialog splits larger ones).

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
- **IA** (`nav/` stays derived from `ROLE_CAPS`; retired routes 302):

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

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| F0 | Harness + CI: local auth hook, CI-only staff per role, `loginAs`, per-role admin sweep (no console errors or overflow, from the client's `adfull.mjs`), admin CSP (server HTML) + axe baselines, `login.astro` grandfathered until F7; commit `docs/admin-v2/*` [R0, AV-01] | H4 | Built: [F0](as-built/F0.md) |
| F1 | Design system, verbatim-first from `app.css`, with the test-pin edits listed per file — **the whole admin takes the new look** [AV-02] | F0 | Built: [F1](as-built/F1.md) |
| F2 | Shell + IA + retired-route stubs + counts [AV-03] | F1 | Built: [F2](as-built/F2.md) |
| F3 | Overlays on `<dialog>`, toasts, ⌘K + `/api/admin/search` [AV-04] | F2 | Built: [F3](as-built/F3.md) |
| F4 | Component kit, rolldown chunk groups + chunk tests, bundle budget definition (O-15) [AV-07] | F1 | Built: [F4a](as-built/F4a.md), [F4b](as-built/F4b.md) |
| F5 | Field kit v2 + `useEntitySave` + Arabic-digit round-trip test [AV-08] | F4 | Built: [F5a](as-built/F5a.md), [F5b](as-built/F5b.md) |
| F6 | Built-in section copy as shared data (byte-identical public HTML) [AV-23] | — | Built: [F6](as-built/F6.md) |
| F7 | Sign-in v2, remember-me, forgot/reset; login stops downloading admin-ui (≈166 KB) [AV-06] | F1 | Built: [F7](as-built/F7.md) |
| F8 | Prefs, `staff_directory`, notifications bell, account (profile, password) [AV-05] | F3 | Built: [F8](as-built/F8.md) |

**Phase 1 — Screens on the kit (live save until R14)**

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| U1 | Dashboard + per-user layout + quick actions + owner role presets + team notes [AV-09+] | F8, F4 | Built: [U1](as-built/U1.md) |
| U2 | Website stats v1 + Site health v1 + `rollup_daily_vitals` [AV-10] | F4 | Built: [U2](as-built/U2.md) |
| U3 | Uploads pipeline (A5, re-encode, EXIF strip, 25 MB, schema widening) [AV-11+] | F0, H3 | Built: [U3](as-built/U3.md) |
| U4 | Media library + picker with upload [AV-12] | F5, U3 | Built: [U4](as-built/U4.md) |
| U5 | Services area (value cards ≤ 4, problems ≤ 5, after checking rows) [AV-14] | F5, U4 | Built: [U5-U6](as-built/U5-U6.md) |
| U6 | Projects area [AV-15] | F5, U4 | Built: [U5-U6](as-built/U5-U6.md) |
| U7 | Collections + `faq_items` (delta seed before `CONTACT_FAQ` goes; e2e keeps FAQ + JSON-LD) [AV-16] | F5 | Built: [U7](as-built/U7.md) |
| U8 | Creative Knowledge, Style-Finder, Job applications on the kit [AV-17] | F5 | Built: [U8](as-built/U8.md) |
| U9 | General: typed identity, favicon/manifest, footer columns, timezone (closed list); maintenance with bilingual copy, background, contact buttons, "Back on" auto-off, show date, a staff-bypass toggle (fail-closed), IP allowlist — all in the KV value; Retry-After from "Back on" [AV-18+] | F5 | Built: [U9](as-built/U9.md) |
| U10 | SEO [AV-19] | F5 | Built: [U10](as-built/U10.md) |
| U11 | Integrations (typed) + notification prefs [AV-20] | F8, F5 | Built: [U11](as-built/U11.md), [U11c](as-built/U11c.md) |
| U12 | Users & roles: emails, invites (resend/cancel), **owner protection**, Security card (session ≤ 7 days, invite domain, invite message; "Require 2FA" arrives with U17), read-only matrix [AV-21+] | F8 | Built: [U12a](as-built/U12a.md), [U12b](as-built/U12b.md) (invites off until SMTP, O-2) |
| U13 | Activity log: person/date/kind filters, names, plain language, export under the lockdown (`export.csv` holders; the §5 export row label is extended, no new cap) [AV-22+] | F8, F4 | Built: [U13](as-built/U13.md) |
| U14 | Page visibility (own table, Admin+Dev): public / hidden (404 or redirect to any page) / link only / **password** (pre-cache gate, private no-store, bcrypt via service RPC, signed per-page cookie, limiter) / hide-from–show-on dates; template-wide hide; KV snapshot; nav/sitemap/llms exclusion [AV-13+] | F4 | Built: [U14a](as-built/U14a.md), [U14b](as-built/U14b.md) |
| U15 | GA4 behind `hasConsent('analytics')`: same-origin loader, CSP sources only while an id is set (Report-Only cycle), GA tab via the Data API | F5, U11 | Built: [U15](as-built/U15.md) (held off until the notice sign-off; the GA tab waits on O-18) |
| U16 | Help centre: `help_articles` (typed blocks, no HTML), the "?" drawer with search, per-screen guides filtered by caps; articles rewritten for built features | F3 | Built: [U16](as-built/U16.md) |
| U17 | 2FA: TOTP enrolment in Account, "Require 2FA" (aal2 in `resolveAuthContext`), Admin "Reset 2FA" (audited) | F8, U12 | Built: [U17](as-built/U17.md) |

**Phase 2 — Releases** (backend lane starts after F0)

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| R1 | Ledger schema, registry, protected flag table, snapshot coverage, `content_versions` hardening (inert; P-14 grants) | F0 | Built: [R1](as-built/R1.md) |
| R2 | Registry, caps and overlay core (TS) | R1 | Built: [R2](as-built/R2.md) |
| R3 | Staged writes in the kernel (behind the flag) | R2 | Built: [R3a](as-built/R3a.md), [R3b](as-built/R3b.md) |
| R4 | `apply_release` (fail-fast, ~60-item cap, tenant from profile) + capture | R1 | Built: [R4](as-built/R4.md) |
| R5 | Guard (no depth exemption), cascade + out-of-band capture, `media_usage` v4, attention v4 | R4 | Built: [R5](as-built/R5.md) |
| R6 | Publish + validate endpoints | R3, R4 | Built: [R6](as-built/R6.md) |
| R7 | Purge seam (cache-layer aware + CI check), `SECTION_READS`, `media:all` on 8 routes, minute cron | R2, R6 | Built: [R7](as-built/R7.md) |
| R8 | Preview data seam (narrowed overlay, `range()` paging, fail-closed ribbon) | R2 | Built: [R8](as-built/R8.md) |
| R9 | Preview route, layout mode, bridge (in `src/lib/admin`), CSP `frame-src` | R8 | Built: [R9](as-built/R9.md) |
| R10 | Versions, history (+ page-scoped restore), Restore vN | R6, R9, R5 | Built: [R10](as-built/R10.md) |
| R11 | Scheduled releases + enable/disable functions | R6, R7, R5 | Built: [R11](as-built/R11.md) |
| R12 | Release UX I: savebar, review, publish dialog (per-item eligibility), conflicts, badges, draft autosave | R6, R7, R9, F5 | Built: [R12](as-built/R12.md), [R12b](as-built/R12b.md) |
| R13 | Release UX II: Backups & versions page, history drawer, dashboard publish card | R10, R11, R12 | Built: [R13](as-built/R13.md) |
| R14 | **Switch-on**: amendments, runbook, e2e in release mode, static write-path test, CPU measurements (O-16) | R3–R13 + staged U screens | Prepared and rehearsed: [R14-prep](as-built/R14-prep.md), [R14a](as-built/R14a.md). The switch-on waits on the owner (O-5, a final go after a green rehearsal) |
| R17 | Scheduled content backups: daily export-backup JSON to R2 (keep 30), "Back up now", download under the lockdown, restore as drafts through releases | R10, R14 | Not built (after R14; O-17) |

**Phase 3 — Page editing & appearance** (after R9 + R12)

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| E1 | Pages list + page editor core [AV-25] | R12, F6, U10 | Built: [E1](as-built/E1.md) |
| E2 | Live preview column [AV-26] | E1, R9 | Built: [E2](as-built/E2.md) |
| E3 | Template editors + editable shared text (`template_copy`, staged, AR required, code defaults) [AV-31+] | E2, U5, U6 | Built: [E3](as-built/E3.md) |
| E4 | Theme v1 + `theme.css` + contrast gate + motion-reducing settings [AV-27+] | R12, E2 | Built: [E4](as-built/E4.md) |
| E5 | Header + `site_appearance` (bucketed options, as in Track UI) [AV-28+] | R12, E2 | Built: [E5](as-built/E5.md) |
| E6 | Footer [AV-29] | E5, U9 | Built: [E6](as-built/E6.md) |
| E7 | Loading screen (all styles incl. bar and tagline; lhci re-gate) [AV-30+] | E5 | Built: [E7](as-built/E7.md) |
| E8 | Forms config: labels, visible/required for optional fields, order, button text, budget labels, consent-copy versions, captcha toggle (O-19); server validation follows the config | R12, U9 | Built: [E8](as-built/E8.md) (the captcha waits on O-19) |
| E9 | Section appearance: background/spacing/reveal variants, editable anchors (slug rules, unique per page); contrast pairs + visual baselines | E1 | Built: [E9](as-built/E9.md) |
| E10 | New section types: Text block, Gallery, Video (showreel window, zero bytes before intersection) | E1 | Built: [E10](as-built/E10.md) |
| E11 | Custom pages: New page + Tier A `[slug]` and `/ar/[slug]` routes with SeoHead, JSON-LD, sitemap, hreflang, tags [AV-33] | E10 | Built: [E11](as-built/E11.md) |
| E12 | Theme v2: radius, button style, heading weight/case tokens + visual regression [AV-32] | E4 | Built: [E12](as-built/E12.md) |
| E13 | Font catalogue: curated self-hosted families (pre-subset woff2 + per-weight/per-script metric fallbacks, ≤ 180 KB/route) | E12 | Built: [E13](as-built/E13.md) (the brand's families until O-21) |

**Phase 4 — CRM core + Sales** (lane starts after F4/F5)

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| C1 | Leads v2 schema (all P-14 + DB-layer PII rules, spam, lead_number, ingest RPC) | F0, H1, H2 | Built: [C1a-1](as-built/C1a-1.md), [C1a-2](as-built/C1a-2.md), [C1b](as-built/C1b.md) |
| C2 | Leads read API (query/board/summary, audited reveal, notes path, directory) | C1 | Built: [C2a](as-built/C2a.md), [C2b](as-built/C2b.md) |
| C3 | Leads write API (versioned PATCH, bulk with per-lead audit, manual add, erase, export filters) | C2 | Built: [C3](as-built/C3.md) |
| C4 | Leads UI (list + KPIs, board with keyboard "Move to…", detail, add drawer) | C3, F5 | Built: [C4a](as-built/C4a.md), [C4b](as-built/C4b.md), [C4c](as-built/C4c.md), [C4-star-race](as-built/C4-star-race.md) |
| C5 | Contacts schema + ingest linking + phone link-and-flag + retention + person erase (**merge gated on O-11**) | C3 | Not built: its merge waits on O-11 (legal) |
| C6 | Contacts API | C5 | Not built (after C5) |
| C7 | Contacts UI + contacts in ⌘K | C6, C4 | Not built (after C6) |
| C8 | Tasks | C6, F5 | Not built (after C6) |
| C9 | CRM settings (stages with a colour picker + AA gate, scoring, custom fields, SLA, assignment) | C4, C7 | Lead settings built: [C9a](as-built/C9a.md); contact settings and custom fields come with C7 |
| C10 | **Sales role** (enum file alone, then helpers; `ROLE_CAPS`, §5, architecture §3.4 parsed by CI; catalog-driven exposure test; `analytics.read`) | C4, C7, C8, C9 | Built for leads: [C10a](as-built/C10a.md); contacts and tasks for Sales come with C7 and C8 |
| C11 | Companies + find-or-create at ingest | C7, C10 | Not built (after C7) |
| C12 | Merge duplicates | C7, C10 | Not built (after C7) |
| C13 | Lead attribution (consent-gated) + privacy notice — **blocked on O-11** | C2 | Not built: waits on O-11 (legal) |
| C14 | Contract (drop legacy status / internal_notes / ip_inet) | C4, C10 | Built: [C14a](as-built/C14a.md), [C14b](as-built/C14b.md) |
| C15 | CSV import (`crm.import`, Admin): server parse, ≤ 5,000 rows / 2 MB, per-row lawful basis, blind-index dedupe, rate-limited, audited counts | C7 | Not built (after C7) |
| C16 | Contact files (private bucket, byte-sniffed, audited download) | C7 | Not built (after C7) |

**Phase 5 — Growth within the standard**

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| G1 | Stats v2 on already-consented data: sessions, events (`cta_click`, `service_interest`), views→inquiry funnel, busiest hours (Riyadh), goals, realtime from a 1-minute rollup | U2 | Built: [G1](as-built/G1.md) |
| G2 | Health v2: uptime from the external monitor's API (O-20), SSL/domain expiry via RDAP in the daily cron, failing checks in the bell | U2, F8 | Built: [G2](as-built/G2.md) (uptime needs O-20) |

**Phase 6 — Closure**

| # | Slice | Depends | Status (Z1, 2026-11-05) |
|---|---|---|---|
| Z1 | Admin visual baselines (1440/390), full per-role axe matrix with dialogs open, docs + TDD coverage closure [AV-34] | E1, E4, E5, U12, U13, C10 | Built: [Z1](as-built/Z1.md) |
| R15 | Release contract | R14 + one stable cycle | Not built (after R14 and one stable cycle) |
| R16 | PDPL history redaction — **legal-gated (O-12)** | R4, R14 | Not built: waits on O-12 (legal) |

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

## Wave 0: the shared files, split

Before the three lanes run in parallel, Wave 0 (W0-a to W0-d, each with its file under "As
built") split the files every slice would otherwise edit, so a later slice mostly adds a file.
The designs were written before it, so the file lists in [ui.md](ui.md),
[releases.md](releases.md) and [crm.md](crm.md), and some rows of
[deviations.md](deviations.md), name the old places ([verification.md](verification.md) keeps
them on purpose: it records file:line evidence as it stood). Wave 0 moved these, and where a
design or the register names the old place, the new one wins:

| Before Wave 0 | Since Wave 0 |
|---|---|
| `src/lib/admin/nav.ts` | `src/lib/admin/nav/<area>.ts`, composed in `nav/index.ts` |
| `src/lib/admin/resources.ts` | `src/lib/admin/resources/<entity>.ts` |
| `src/lib/admin/uiSchema.ts` | `src/lib/admin/ui/<entity>.ts` (`uiSchema.ts` is a re-export) |
| the nine legacy panels in `src/components/admin/` | `src/components/admin/screens/<name>/`, each hydrated through its `islands/Admin*.tsx` entry |
| the shell's `COUNTERS` (`shell.ts`) | `src/lib/admin/counters/` |
| a screen's own CSS in `admin.css` | `public/styles/admin/<screen>.css`, listed in `src/lib/admin/stylesheets.ts` |
| rows in `tests/authz/endpoints.spec.ts` | `tests/authz/cases/<feature>.ts`, each case named in `tests/authz/caseManifest.ts` |
| steps in `src/lib/cron/daily.ts` | entries in `src/lib/cron/jobs.ts` |
| a public loader calling `anonClient()` | `contentClient()` (`src/lib/data/source.ts`) |

**The F0 harness extension (built by C4b).** An edit screen with no resource config (C4b's
`/admin/leads/[id]`, later the page editor) declares how the sweep finds a row in
`EDIT_SAMPLES` (`tests/admin/routes.ts`: its POST list, the capability, and the route that adds
a row), and `tests/admin/samples.setup.ts` adds one as the admin when the list is empty.

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
  - every new route's cases in its feature's module, `tests/authz/cases/<feature>.ts`, each named in `tests/authz/caseManifest.ts` (`endpoints.spec` runs them over `ROLES`; `endpointCoverage.spec` fails on a route without one);
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
  - per-role admin sweep, and every dialog its screens open (the Z1 matrix);
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

   | Acceptance item | Slice | Status | As built (Z1, 2026-11-05) |
   |---|---|---|---|
   | Every route for every role: no errors, no overflow, sidebar per role | F0/Z1 | ✓ per-role sessions replace View as; https, not `file://` | Built: the F0 sweep (`tests/admin/sweep.e2e.ts`, every screen each role's sidebar offers, axe included), Z1's dialog matrix (`tests/admin/dialogs.e2e.ts`: every dialog those screens open, per role, axe with it open) and the admin visual baselines at 1440 and 390 (`tests/visual/admin.visual.ts`, made and checked by the hand-run `admin-visual.yml`, [Z1](as-built/Z1.md)) |
   | Homepage headline visible after Publish, not before | R14 | ✓ | Built in the release-mode rehearsal ([R14-prep](as-built/R14-prep.md), [R14a](as-built/R14a.md)): `tests/admin/releases-mode.e2e.ts` publishes a pending change and reads it on the public page, then a scheduled release and a rollback. Production waits on R14's switch-on (O-5) |
   | Hidden page returns 404 and leaves the menu | U14 | ✓ incl. sitemap/llms and KV re-sync after rollback | Built: `tests/admin/visibility.e2e.ts` ([U14a](as-built/U14a.md), [U14b](as-built/U14b.md)) |
   | 503 for visitors, signed-in admin passes | U9 | ✓ fail-closed (built: `tests/admin/maintenance.e2e.ts`) | Built: `tests/admin/maintenance.e2e.ts` ([U9](as-built/U9.md)) |
   | Sales cannot open users by URL, API or PostgREST | C10 | ✓ | Built: [C10a](as-built/C10a.md) (`tests/admin/refusals.e2e.ts`, `endpoints.spec`, the catalog-driven pgTAP) |
   | A deleted project comes back | R10 | ✓ Restore vN, with portfolio children | Built with releases on: [R10](as-built/R10.md)'s Restore vN (`tests/admin/backups.e2e.ts`, the rehearsal's rollback); a full restore is the quarterly DR drill |
   | A form submission is a lead within 5 s | C1 | ✓ bell notification; email delivery is L6 | Built: [C1b](as-built/C1b.md)'s ingest and [F8](as-built/F8.md)'s bell; `notify-lead` writes `notification_log` ([H9](as-built/H9.md)) and sends nothing (A1) |
   | Template editor + preview | E2/E3 | ✓ after the autosave reload | Built: [E2](as-built/E2.md), [E3](as-built/E3.md) (`tests/admin/templates.e2e.ts`, `page-preview.e2e.ts`) |
   | Public pages clean | R9 | ✓ inverted: the bridge must *not* be on public pages | Built: [R9](as-built/R9.md) (`tests/admin/preview-isolation.e2e.ts`, `preview-parity.e2e.ts`) |
   | Campaign / WhatsApp 24 h / automation / Get connected | L6 | — | Not built (A1) |

## Owner items

- **Provisioning**
  - **O-1** Supabase Storage bucket `media` (staging + prod).
  - **O-2** SMTP for Supabase Auth (invites, reset), with SPF/DKIM. For the reset (F7), also the recovery template, the link's one-hour lifetime and `AUTH_EMAIL_READY` (launch runbook §2b), and, before that switch, a decision on the reset token in Workers Logs' request URLs ([deviations.md](deviations.md), residual risks); until then "Forgot password?" says "Not set up".
  - **O-3** Cloudflare zone + a cache-purge-only token (KAN-20). Until then purges do nothing and pages stay fresh.
  - **O-17** An R2 bucket for scheduled content backups (R17).
  - **O-18** A GA4 property + Data API service account (U15). As built: the property (2 months' retention, Google signals and ad personalisation off) and the owner's sign-off of the notice that names Google come before GA4's switch-on (launch runbook §2e); the service account waits for the GA tab, deferred until then ([U15](as-built/U15.md)).
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
  - **O-15** Admin bundle budget: the eager graph per admin route ≤ 300 KB gz (recommended), or keep the 300 KB sum, or raise the number. *Decided by the approved plan's default on 2026-10-18 (C4b): the per-screen eager graph is the gate, the sum a coarse tripwire, 400 KB, then 450 KB from 2026-10-29 by the owner's decision of 2026-10-28 (CLAUDE.md §2, the F4 amendment).*
  - **O-22** Invites expire in ≤ 24 h (Supabase limit), with Resend, instead of 7 days until L6.
- **Ops checks**
  - **O-16** Workers plan: measure CPU and subrequests for publish/validate, preview SSR, `/_image`, `theme.css` and the lead CSV export at its cap (`GET /api/admin/leads/export` carrying 80 leads with contact details, `EXPORT_ROW_CAP.pii`: its rows were measured at up to 6 ms, the rest of the request was not, [C3](as-built/C3.md)), and the leads pages' server render (`/admin/leads?range=30`: 9 round trips, two summaries; `/admin/leads/<id>`: 9; [C4b](as-built/C4b.md)) on staging. The Free plan allows 10 ms/request. Workers Paid ($5/mo) may be needed.
  - **O-23** Production checks: Postgres major ≥ 15, leads grants (H2), and whether the pg_cron role bypasses RLS (retention).
  - **O-24** Supabase Auth on staging and production (launch runbook §2a, F8): require the current password to change one, minimum password length 10, Secure password change on; and accept what remains (a direct call at the auth server counts no lockout, and a direct change is audited only in GoTrue's own log, as `user_updated_password`, never in the app's hash-chained `audit_log`). Until then a session token alone changes its owner's password at the auth server, and GoTrue signs out every other session of that user, the owner's own devices included ([deviations.md](deviations.md), residual risks, which also names a compensating alert the owner may choose). And for F7 (runbook §2c): a session inactivity timeout of 7 days, the session cookie's own, and optionally a time-box, so a copied session cookie stops working too (a paid-plan setting); until then the residual CLAUDE.md §3 states stands.
  - **O-25** Two factor sign in (U17, launch runbook §2d): confirm Supabase Auth's TOTP is enabled on staging and production (enrol and verify, at most 10 factors; the hosted default), and accept what stays open ([deviations.md](deviations.md), residual risks): a code typed at Supabase Auth's own verify endpoint counts no lockout, people who have not set 2FA up are protected by their password alone, a token minted before 2FA or Require was turned on keeps its role at PostgREST for up to an hour, and there are no recovery codes (a lost phone needs an Admin's Reset 2FA; the owner's needs the runbook, §3a). Also a product confirmation (with O-13): setup lives on its own page, `/admin/2fa`, not in the account drawer, and Require 2FA's hint says "at their next click", not the prototype's "at next sign-in".
  - **O-26** *Done 2026-10-31 (supply-chain hardening PR):* every action in every workflow is pinned to a commit (`actions/checkout` v4.3.1 and `actions/setup-node` v4.4.0 at the deploy job's commits, `supabase/setup-cli` at v1.7.3's), and the preview wait is a `curl` loop instead of `npx wait-on`, which fetched an unpinned package at run time. `tests/ci/workflows.spec.ts` holds both: a commit pin on every `uses`, one commit per action, and no `npx` of a package outside the lockfile. Renovate can move the pins (`helpers:pinGitHubActionDigests`).

## Open owner items and legal holds (Z1, 2026-11-05)

Everything still waiting on the owner or on a lawyer, in one place, as the closing pass found it
on main d48e287d. "Built to the default" means a slice shipped the recommended answer and the
owner's confirmation is what remains; the item's own text is under "Owner items" above.

| Item | Waits for | What it holds back | State |
|---|---|---|---|
| O-1 | The `media` bucket on staging and production | Uploads (U3) in each project | Built to the default (U3's migration creates it); the owner confirms it in each project |
| O-2 | SMTP for Supabase Auth, the recovery template, `AUTH_EMAIL_READY` | Invites (U12b), Forgot password (F7); the reset-token residual | Open |
| O-3 | A Cloudflare zone and a purge-only token (KAN-20) | Edge caching of Tier A and every purge (R7 logs a no-op) | Open |
| O-4 | Approval of the release semantics | R14's switch-on | Built to the default (R11, R12); approval open |
| O-5 | The switch-on window, operator and fallback scheduler | R14 | Open: a final go after a green rehearsal (decided 2026-10-28) |
| O-6 | Sales sees budget and timeline one lead at a time | The CRM's Sales posture | Built to the default (C10a); confirmation open |
| O-7 | Developer gets no CRM contacts or tasks | C7, C8 | Default recorded; applies when they are built |
| O-8 | Legacy "done" leads backfill to Lost | The leads contract | Built to the default (C1a-2, C14b); confirmation open |
| O-9 | Reveal and erasure limits, Admin-only erasure, manual assignment, the Tasks badge | The CRM | Built to the defaults (C2b, C3, C9a); confirmation open |
| O-10 | Stage presets and tones; the studio's time zone | The CRM | Built to the defaults (C9a; the zone is `site_settings.timezone` since U9); confirmation open |
| O-11 | **Legal:** the privacy-notice updates | C5 (contacts) and C13 (attribution), so C6 to C8, C11, C12, C15, C16 after them | Open |
| O-12 | **Legal:** history redaction and a retention period for release history | R16, and two R14 blockers in the residual-risks register ([deviations.md](deviations.md): team members not captured; a removed quote stays in history) | Open |
| O-13 | Approval of the deviations register | The register as it stands | Open |
| O-14 | The logo stays code, the FAQ's owner, "Keep me signed in" on, the intro switch | E7, U7, F7 | Built to the defaults; confirmation open |
| O-15 | The admin bundle budget | — | Decided: the per-screen eager graph ≤ 300 KB is the gate, the sum a 450 KB tripwire (2026-10-18, 2026-10-28) |
| O-16 | CPU and subrequest measurements on staging | The Workers plan (Free or Paid) | Open |
| O-17 | An R2 bucket for scheduled content backups | R17 | Open |
| O-18 | A GA4 property and a Data API service account | GA4's switch-on (with the notice, below) and the GA tab | Open |
| O-19 | A captcha provider | The forms' captcha (shown as Not set up) | Open |
| O-20 | The uptime monitor's API key | G2's uptime figures | Open |
| O-21 | Font families with web licences | E13's catalogue beyond Archivo and Almarai | Open |
| O-22 | Invites that last at most a day, with Resend | Invites | Built to the default (U12b); waits on O-2 too |
| O-23 | Production checks: Postgres ≥ 15, the leads grants, pg_cron and RLS | Retention jobs on production | Open |
| O-24 | Supabase Auth's password and session settings, and the residuals | F7, F8 | Open; the residuals expire 2026-11-30 and 2026-12-31 ([deviations.md](deviations.md)) |
| O-25 | TOTP on staging and production, and what stays open | U17 | Open; the residual expires 2026-12-31 |
| O-26 | Actions pinned to commits | — | Done 2026-10-31 |

Legal holds outside the O-items:
- **GA4's notice:** `GA4_NOTICE_READY` stays off in production until the owner signs off the
  privacy notice that names Google (U15; launch runbook §2e), then O-18.
- **Raw telemetry retention:** `RAW_TELEMETRY_RETENTION` (90 days) waits on PDPL sign-off and
  may only go shorter (CLAUDE.md, Pillar 4).
- **L5:** referrer, UTM, device, country and a persistent visitor id wait on PDPL sign-off.
- **The legal review register** (`docs/legal/review-register.md`): L-1, the font licences'
  notice (LOW, open). Go-live waits on every HIGH item; there is none open.

The security exceptions the owner holds, each with its expiry, are in
`docs/security-exceptions.md` (open: EXC-004, EXC-006 to EXC-013).

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

Each slice records where its implementation departs from the design it builds, and why, in
its own file under [as-built/](as-built/), so the designs stay readable as the reasoning and
those files stay the truth. A slice's PR adds its file and one line below, under its lane,
and moves any migration it carries to "Applied" in [migrations.md](migrations.md) once
production has applied it, so nothing is edited after the merge; a new file's header names its
PR, not the merge commit, which does not exist yet. Most hotfixes found after this document
was written (H5 onward) have no design to depart from, so their files record what was built
and why; H6 pulls part of R1 forward and records its departures from it.

**UI**
- [F0](as-built/F0.md): harness and CI (#34)
- [F1](as-built/F1.md): the design system (#35, folded into #34)
- [F2](as-built/F2.md): the shell and the information architecture (#37, folded into #34)
- [F3](as-built/F3.md): overlays, toasts and the command palette (#39, folded into #34)
- [F4a](as-built/F4a.md): the admin bundle plan (#40, folded into #34)
- [F4b](as-built/F4b.md): the component kit: server primitives, SVG charts, DataTable, tabs, chips, the Sortable core, ResourceTable on DataTable, `/admin/kit` (#64)
- [F5a](as-built/F5a.md): the field kit v2: FieldShell, bilingual with EN | AR | Both, switch, colour, range, chips, repeater on the Sortable, the media tile, the rich-text link dialog, `useEntitySave` and `EditorForm` under ResourceForm and SingletonForm, the `admin-fields` chunk, the Arabic-digit guard (PR number at review)
- [F5b](as-built/F5b.md): the rest of the field kit: accent word ranges, the link field and `GET /api/admin/linkables`, the slug list, clip v2 on the site clip registry, section content stored as differences from the built-in copy, `SECTION_ADVANCED_ONLY` down to `hero.intro` (PR number at review)
- [F6](as-built/F6.md): built-in section copy as shared data, the public HTML byte-identical (#60)
- [F7](as-built/F7.md): sign-in v2, keep me signed in, forgot and reset password (#61)
- [F8](as-built/F8.md): the personal layer: preferences, the people directory, the bell, the account, the environment pill, 0044
- [U1](as-built/U1.md): the dashboard: a server widget registry that loads only the role's widgets, per-person layout and quick actions, Admin's role presets (library actions only), team notes without contact details cleared after 180 days by pg_cron, "Going live today" on the Riyadh day, 0060 (PR number at review)
- [U2](as-built/U2.md): website stats and site health on the rollups, server-rendered: `rollup_daily_vitals`, the invoker readers, whole-day page views, the health checklist, `/admin/logs` retired, 0052 (PR number at review)
- [G1](as-built/G1.md): website stats v2, folded (G1a, G1b, G1c): the public site's click and explorer events, visits per tab and UTC day, the funnel, events, busiest hours in Riyadh time, realtime from a pg_cron minute rollup with Pause, the Right now widget, goals under the new `analytics.goals` (Admin, SEO), raw telemetry for the service role only, 0071 (PR number at review)
- [U3](as-built/U3.md): media uploads (A5): the storage provider, the upload, replace and download routes, delivery through `/_image`, 0045 (PR number at review)
- [U4](as-built/U4.md): the media library and the picker with upload: search, Images | Videos, the storage meter, describe-then-upload with progress, the drawer (alt, tags, Used in, Download, Replace, Delete), Upload in place in every picture field, the shared `admin-screens` chunk group, `media_library`, 0064 (PR number at review)
- [U9](as-built/U9.md): General settings and maintenance v2, folded U9a + U9b: typed identity (tagline, phone, map link, socials with Show on the site), the favicon and app icon with the manifests, the footer settings columns, `site_settings.timezone` and the admin clock on it, the RESTRICTIVE live writes on both rows; maintenance in one KV value (copy, background, buttons, Back on, the fail-closed staff bypass, the allowlist), Retry-After from Back on, the 503 in both languages, Preview full screen, the 10-minute reconcile; four guides through H11's catalog (general-settings, maintenance-mode, and one sentence each of website-stats and site-health-and-logs); 0102 (built as the 0075 placeholder; PR number at review)
- [U10](as-built/U10.md): SEO, folded U10a + U10b: share images from the media library (`og_media_id`, `default_og_media_id`, composite keys, `media_assets_public_read` and `media_usage` v5), the pair rule, closed robots, localized canonical paths, the sitemap and llms.txt indexability filter, `/admin/seo` with Pages, Redirects and Site wide, the shared `SeoPanel`, the guide put through H11's catalog, 0073 placeholder (PR number at review)
- [U8](as-built/U8.md): Creative Knowledge, Style-Finder and Job applications on the kit, folded U8a + U8b: job applications as a DataTable and a wide drawer (one audited reveal kept in memory, `?status` and `?open`, the bell opens one, the closed-form note), the Style-Finder's options repeater and not-live notes, the kit's `TabStrip`, `EditorForm` tabs and read-only mode (the tab API U5 and U6 inherit), the post editor in tabs with the SEO panel, a published author required, an untouched body no longer blanking `body_html`, the `style-finder` and `job-applications` guides put through H11's catalog, 0101 (built as the 0074 placeholder; PR number at review)
- [U5 and U6](as-built/U5-U6.md): the Services area and the Projects area on the kit, folded: the disciplines' overview with the eye, the drawer and the order, a discipline's page with its services ordered inside its own numbers and the leads by service (`public.lead_interest_counts`, counts only), the service editor in tabs with its case study and leads, the projects list with search, chips and Manage tags, the project editor in tabs with its media as four controls over one `save_portfolio` call and the publish requirements, 4 value cards and 5 problems in the admin, the `admin-content` chunk group, the services-and-projects guide (place 42), 0111 placeholder (PR number at review)
- [U13](as-built/U13.md): the activity log v2: names, kind, person and day filters, plain language, the export under the lockdown, the live read on `audit_log`, 0054
- [U14a](as-built/U14a.md): page visibility without the password mode: `page_visibility`, the middleware gate on the matched route, KV `site:visibility` through a 60 s isolate memo, the menus, sitemap, llms.txt and search filtered, `/admin/visibility`, the `nav_visible` alias, the registry row, 0057 (PR number at review)
- [U14b](as-built/U14b.md): the password mode: `page_passwords` (bcrypt, no policy and no API-role privilege), `set_page_password` and `page_password_check`, the signed per-page cookie and `/api/page-access` with a limiter that fails closed, the gate page, and the `page_sections` fence with `page_sections_unlocked` and `page_media_unlocked` for an unlocked request, 0061 (PR number at review)
- [G2](as-built/G2.md): site health v2: uptime from the monitor's read-only API, the domain's RDAP expiry, the health schedule (`*/10`, the cron dispatcher), the Security tab, Check now, probe failures in the bell, 0067 (PR number at review)
- [U16](as-built/U16.md): the help centre: guides as typed blocks in the database, the "?" drawer with search and this screen's guides, `/admin/help`, 0046 (#62)
- [U12a](as-built/U12a.md): users v2 and the session posture: the token's own claims and the session length checked, sessions revoked on a role change, the live read of profiles, the account owner, the Security card, the read-only role matrix, 0055 (PR number at review)
- [U12b](as-built/U12b.md): invites: the acceptance page `/admin/invite` (eight pre-auth paths), Pending invites with Resend and Cancel, the invite drawer and message, switched off ("Not set up") until SMTP, the invite e-mail template, no address in the invite audit rows, 0056 (the help guide; PR number at review)
- [U7](as-built/U7.md): collections and the FAQ, folded (U7a + U7b): `faq_items` (bilingual plain text, its CHECK, anon's column grant, registry row, guard, capture, history, `publish_scheduled`), one loader for the Contact band and its FAQPage with no code copy, the delta seed before the merge, the generic `AdminCollection` island (list, drawer, order, duplicate) for the FAQ and the five collections, the sample quote made real in one save, the collections-and-faq guide (one `app.put_help_guide`, revision 0), 0098 (built as 0070, renumbered at merge; #90)
- [U17](as-built/U17.md): two factor sign in: TOTP set up on `/admin/2fa` (zero JS, the key and an `otpauth://` link), the second step held in two layers (the token hook at the required `aal`, `resolveAuthContext`'s pending step), Require 2FA for everyone, Reset 2FA, the 2FA column and health check, its two guides put through H11's catalog, 0072 (PR number at review)
- [U11](as-built/U11.md): integrations, typed: a GA4 measurement id, the Search Console code and a Calendly link as CHECKed public identifiers, Admin + SEO in both layers behind a live check, the verification tag on the home pages through the content seam and the preview mirror, the captcha Not set up; the Forms overview; the bell's settings for every member; four guides put through H11's catalog, 0105 placeholder (PR number at review)
- [U11c](as-built/U11c.md): the integrations contract: `site_integrations`' four legacy jsonb columns dropped after U11's deploy (the push refuses while any row still holds JSON), the grants restated on the columns that remain, every reader of the table held to them by a test, the rollback line moved to U11's PR, 0110 placeholder (PR number at review)
- [U15](as-built/U15.md): GA4 behind analytics consent: anon's read of the measurement id, one read per public page only while the code switch `GA4_NOTICE_READY` is on (off in production until the owner signs off the notice that names Google; on in the CI e2e build), the same-origin loader (gtag.js after a yes and after `load`, consent mode with every ad signal denied, withdrawal across tabs), Google's hosts in the CSP only on a page that loads it, the Report-Only cycle as reports of refused Google hosts, the tile saying why a saved id does not load yet, the switch-on guard and the notice drafts; the GA tab (Data API) deferred to O-18; 0114 placeholder (PR number at review)
- [E1](as-built/E1.md): the pages list and the page editor core: server-rendered page cards and template cards, the `AdminPageEditor` island (the bar with English / العربية / Both and "Arabic missing", the sections column with the eye, Rename, Move up / down and drag, Add section with its reasons, Delete for an Admin, each section's typed fields prefilled with its look's built-in copy and storing only what differs, the page details), the SEO and History drawers, the `admin-pages` chunk group, `page_sections.label` and the `editing-pages` guide, 0115 placeholder (PR number at review)
- [E5](as-built/E5.md): the Header screen and `site_appearance`: the header's options as closed sets (logo position and size, menu alignment, sticky, hide on scroll, solid after the hero, the tint over the hero with its minimum, the blur, the phone menu, a call-to-action button), a staged per-tenant singleton under `theme.edit` (`app.role_edits_theme`, the release registry, history, the preview mirror), rendered by the public header as `data-*` buckets and byte-identical with no row, the Menu items card over the navigation API (order, key star, eye), the bar's two sketches, the `header-and-menu` guide; 0119 placeholder (PR number at review)
- [E6](as-built/E6.md): the Footer screen and the footer's link columns: the basics (copyright template with `{year}`, `{brand}` and `{place}`, Light or Dark, the mailbox, the social icons) through the identity singleton with a sketch, columns as navigation heading rows (`is_heading`, `navigation_heading_shape`, at most four per tenant, staged through the `nav_item` registry row, a parent keyed with its tenant), the Columns card over the navigation API (add, order, the eye that hides a column with its links, each link's column), the legal links locked (PDPL), rendered server-side and byte-identical with nothing saved, the `footer` guide; 0122 placeholder (PR number at review)
- [E7](as-built/E7.md): the Loading screen: the home hero's on/off switch (`pages.write`, O-14) and the look on `site_appearance`'s `intro_` columns (`theme.edit`): behind the logo the video, black or light, a progress bar, a tagline in both languages, the hold and the fade in buckets (≤ 1.5 s), rendered on the plate as `data-*` buckets and byte-identical with no row, the logo unchanged (the home LCP element), the consent banner above an opaque plate, a preview played from the form, the `loading-screen` guide, and the lhci re-gate of `/` and `/ar` with each style; 0124 placeholder (PR number at review)
- [E2](as-built/E2.md): the page editor's live preview column: R9's preview route framed in a lazy third column (`admin-page-preview`), Desktop / Tablet / Phone scaled through the CSSOM, the language following the editor's, the open section jumped to and outlined, a reload after each save, a click in the preview opening that section (the envelope's new `select`), an Edit | Preview switch below 1280 px; no migration, no write (PR number at review)
- [E4](as-built/E4.md): Theme v1: `/admin/appearance/theme` (`AdminTheme`, its own `admin-theme` chunk family) with Simple and Advanced colours over a contrast gate (packages/theme: 45 pairs of the site and the admin, refused pair by pair in the editor, the Worker and a database CHECK), suggestions in words, motion that only reduces, Reset; `/styles/theme.css?v=<hash of the body>` (custom properties only, immutable and `site:chrome` at the live hash, `no-store` at any other address) linked by BaseLayout and AdminLayout only when a theme sets a token, so an unthemed page is byte for byte as before; staged through the release registry (a preview draws the pending theme); the contrast audit's theme pairs and a themed Lighthouse run in CI; 0120 placeholder (PR number at review)
- [E8](as-built/E8.md): the forms config: `public.form_settings`, a staged singleton (labels, order, the optional fields shown and required, the button, the budget words, the Join consent lines, versioned), the public forms rendered from it server-side, `/api/contact` and `/api/apply` following it after the Zod floor, the `AdminForms` editor at `/admin/forms`, the captcha off and "Not set up" (O-19), 0117 placeholder (PR number at review)
- [E10](as-built/E10.md): three section blocks any routed page may take (Galleries and Videos up to eight a page together): a Text block (rich text in both languages, refused on save unless it is exactly what the editor makes and the allowlist renderer emits, rendered by that renderer every time), a Gallery (1 to 12 media library pictures, lazy and sized) and a Video (a still that plays a window of a site film in view, zero bytes before, with its own pause control, so outside EXC-007); no built-in copy, no JSON-LD, its own e2e project; no migration (PR number at review)
- [E12](as-built/E12.md): Theme v2, shapes and type (AV-32): corners (a closed scale over the site's own radii), buttons (pill, rounded, square), heading weight (800 or 700) and case (capitals or as written) as closed choices in theme settings v2 (a v1 theme reads as the brand's shapes and type), four more closed tokens in the same `theme.css`, read by the public stylesheets with the brand's values as fallbacks (an unthemed page is unchanged), the Shapes and Typography cards, the Arabic preload following the weight, the restated CHECK, and visual regression over the themed output in English and Arabic (computed corners, weights and case per choice, axe, the capture's themed twins); 0121 placeholder (PR number at review)
- [E11](as-built/E11.md): custom pages: New page on the pages list (`pages.write`; the title in both languages and an address, suggested from the English title), the Tier A `/[slug]` and `/ar/[slug]` routes (SeoHead, WebPage and BreadcrumbList, hreflang, `page:<slug>` tags, the sitemap and llms.txt, page visibility and maintenance by its slug), the address rules in one module and a trigger for every writer, the custom section set held at the API, the seeded `how-we-work` sample; 0123 placeholder (PR number at review)
- [E13](as-built/E13.md): Font catalogue: a closed, code-owned catalogue of self-hosted families (`packages/theme/fonts.ts`, `fontFaces.ts`), the faces global.css and admin.css declare held to it block for block, every rule a family must pass checked over it (files, swap, real heading weights, fallbacks per weight, script and platform, hero and route budgets, licence), theme settings v3 with a family per script, two closed font tokens, theme.css carrying a chosen family's faces and the one preload its file, the Fonts card; the brand's Archivo and Almarai only until O-21, so every page is unchanged; 0125 placeholder (#131)
- [E3](as-built/E3.md): the template editors and their shared text: `/admin/pages/template/service` and `/project` (`pages.write`) in the page editor's layout with E2's preview column (Showing, the template's fixed parts read only, "This service" / "This project" saving through the full editors' own path, and the shared text), `public.template_copy`, a staged per-tenant singleton holding only the words that differ from the built-in ones (a closed catalogue per template, English and Arabic both required, held again by `app.template_copy_ok`), the service pages and case studies rendered from it server-side and byte-identical with no row, `app.role_edits_pages`, the `page-templates` guide; 0126 placeholder (PR number at review)
- [E9](as-built/E9.md): section appearance: a background (light grey, black, the primary colour) and a spacing on the blocks, a CSS-only reveal on every kind that does not open a page (never in a page's first two sections, none under reduced motion), and an editable anchor (slug rules, unique per page, never an id the site renders) where the code names none; closed buckets stored on the section (four columns, CHECKs, a deferred UNIQUE), drawn as attributes on its own first element (no `style=`, default byte-identical), staged with the section, in the preview and the link picker; contrast pairs for every background and visual baselines; 0127 placeholder (PR number at review)

**Releases**
- [R1](as-built/R1.md): the release ledger schema, inert, 0038 (#56)
- [R2](as-built/R2.md): the release registry, caps and overlay core in TypeScript, `fields` on every release-managed config, the §5 relabel and the derived release publish matrix, no migration (#68)
- [R3a](as-built/R3a.md): staged writes in the database and the resource kernel, behind the release flag: the draft writes, `public.write_drafts`, the staged branch of every kernel handler, inert, 0062
- [R3b](as-built/R3b.md): staged singletons and entity SEO, the immediate job-application switch (`PATCH /api/admin/site-profile/intake`), the draft endpoints (pending summary, discard one / mine / selected, resolve), inert, no migration (PR number at review)
- [R4](as-built/R4.md): applying a release as the publisher, change capture, the shared link-set helper, the purge record, inert, 0051 (#69)
- [R8](as-built/R8.md): the preview data seam: the scoped `contentClient()`, the narrowed PostgREST emulator, the anon-RLS mirror, the `range()`-paged dataset with drafts overlaid per role, the fail-closed report, no migration (PR number at review)
- [R9](as-built/R9.md): the preview route, `/admin/preview/**` rendering each Tier A page through Astro's rewrite inside the R8 scope, the ribbon, the bridge and its envelope, `frame-src 'self'` on admin responses and a preview render's `connect-src` narrowed to the read-only endpoints, the preview guide put through H11's catalog (one migration, numbered at merge) (PR number at review)
- [R5](as-built/R5.md): the release guard on every registry and link table (no depth exemption), system items and link-set capture with cascades, TRUNCATE closed, `media_usage` v4 (pending changes) and `dashboard_attention` v4 (release kinds), `publish_scheduled` skips tenants with releases on, inert, 0066 (PR number at review)
- [R6](as-built/R6.md): publishing a release and its dry run: `POST /api/admin/releases` and `/validate`, per-change capabilities and the live re-read, the check over the state the selection leaves (the overlay-aware database the domain rules now read, links held to the tenant, dependencies, removed parents), the apply's refusals mapped, the after-effects never fatal and the purge a logged no-op, inert, no migration (PR number at review)
- [R7](as-built/R7.md): the purge seam (Cache-Tag by the zone API, 30 a request, 30,000 a day in a database ledger, a breaker, Not set up without a zone) and the cache-layer check, `SECTION_READS` and every Tier A route's tags in one table (`media:all` on the 8 routes), a release's tags with old and new slugs, the snapshots rebuilt as the system after a release, media and visibility saves purging, the minute cron (claimed once per release), and O-16: one read per publish check for every table, a clean all-types publish at 26 subrequests (one migration, numbered at merge) (PR number at review)
- [R10](as-built/R10.md): numbered versions, history and restore: `content_versions.seq` (1, 2, 3 per entity, given by a trigger no writer can skip), the state at a version from the ledger in one call (`release_as_of`), the versions list and a version's changes per area, Restore vN (the site or one page) and one snapshot's restore staged as pending changes under the person's RLS and marked by the service role (the draft lock keeps their author), refused whole with every item named, the rollback publish, the preview of a version (`?v=N`), inert, 0104 placeholder (PR number at review)
- [R11](as-built/R11.md): scheduled releases and the two switches: `scheduleAt` on publish (2 minutes to 366 days, the changes dry-run as the person, then stored and their drafts claimed), move and cancel (`PATCH`/`DELETE /api/admin/releases/[id]`, every change the person's to publish, checked again in the database), the minute cron's fire (one claim a release, leased, the scheduler re-checked live, `apply_release` in `fire` mode as them, the after-effects as the system), a failure recorded closed with a code and in the bell, `app.enable_releases` and `app.disable_releases` (owner only, audited, refused while a release publishes; off needs the discard named while anything is pending), inert, 0112 placeholder (PR number at review)
- [R12](as-built/R12.md): release UX I: the savebar and the publish dialog (per-item eligibility from today's capabilities, everything I may publish ticked, dependencies ticked with their reason, what waits listed with who can publish it, the check on every selection, Now or Schedule for a day and a time on the studio's clock, Review and Discard), conflicts (Keep my version, Use the live version, Compare: a new read), pending badges on lists and editors, editors following the server into draft mode with autosave on blur, a tab switch and Ctrl/⌘+S, the kit's Publishing card; inert while releases are off, no migration (PR number at review)
- [R12b](as-built/R12b.md): a create or a move made in release mode is refused once releases are off (409 `releases-off`, before any read or write), as R12 refuses a save or a delete: the live create and reorder refuse `?staged=1`; every list takes its mode from its own answer (`readsThroughRelease`), never a row, and marks its moves, eye, drawers' and modals' creates and copies; the editors' Duplicate and Delete follow their own answer, and a create page's create the shell's flag (`src/lib/admin/releasesFlag.ts`, one read per request, shared with the shell); a source scan fails on any unmarked `adminFetch` write to a release-managed route and on any call it cannot read that is not named with its reason; a refused list write is said after the list is read again; no migration (PR number at review)
- [R13](as-built/R13.md): release UX II: Backups & versions at `/admin/backups` for the CMS roles holding a release read capability (the versions with Preview, Details, Restore and its rollback publish, Change time, Unschedule, the purge retry; Download content under the export lockdown; honest while releases are off), the history drawer on every row editor (loaded on first use), the dashboard's publish card (drawn only while releases are on) and `GET /api/admin/releases/status`, `POST /api/admin/releases/[id]/purge`, the release rows and the bell linking to the page, the backups-and-versions guide, 0116 (built as the 0115 placeholder, numbered at its merge train; PR number at review)
- [R14-prep](as-built/R14-prep.md): what R14's switch-on needs but the switch: History on the site identity, the SEO defaults and a page's search settings (a singleton's history named by the session's tenant), the maintenance page's contact buttons after a release that changes the identity, the publish card placed in layouts saved before releases were on, the release-mode rehearsal (`E2E_RELEASES=on`, `.github/workflows/releases-rehearsal.yml`, by hand; the publish, scheduled release and rollback drill), and launch runbook §6p with its read-back; no migration (PR number at review)
- [R14a](as-built/R14a.md): the release-mode rehearsal made green: the shown savebar keeps room for its measured height (the main column's end, the scroll padding, the bulk bar and the toasts; WCAG 2.4.11; nothing moves with releases off), the drill fires the cron through miniflare's `/cdn-cgi/local/scheduled` and starts and ends with nothing scheduled, integrations, media and page-preview hold in both modes, and R14's plan for converting the specs written for releases off; review: a stuck bulk bar's measured height joins the scroll padding while the savebar shows; no migration (#132)

**CRM**
- [C1a-1](as-built/C1a-1.md): lead personal data at the database layer, 0033 (#43)
- [C1a-2](as-built/C1a-2.md): the pipeline, spam horizon, timeline and notes thread, 0034 (#45)
- [C1b](as-built/C1b.md): how a lead arrives, 0035 (#46, folded into #45)
- [C2a](as-built/C2a.md): reading the pipeline, 0036 (#47, folded into #45)
- [C2b](as-built/C2b.md): one lead: the reveal, the notes thread, the timeline (#48, folded into #45)
- [C3](as-built/C3.md): the leads write API: versioned PATCH, bulk, manual add, erase, export filters, 0041
- [C4a](as-built/C4a.md): the leads readers v2: assignee, star, unread, source, channel and discipline filters, the SLA flag, the board's values, the summary's figures, Previous/Next in the list's own order, the score's reasons behind the reveal, 0063 (#79)
- [C4b](as-built/C4b.md): the leads screens: the list with its KPIs, chips, filters in the address and bulk bar, a lead's page (the audited reveal, the notes thread, the status card, Move to…, the timeline, Erase), the lazy add drawer, the `internalNotes` 422, the F0 harness extension, the `admin-leads` chunk groups and O-15 by the plan's default, 0065 (the help guide only; PR number at review)
- [C4c](as-built/C4c.md): the Pipeline board, carved out of C4b by size: a column per stage, Move to… on every card, announced, the List | Pipeline tabs, 0068 (the help guide only, after G2's 0067; PR number at review)
- [C9a](as-built/C9a.md): CRM settings for leads: `crm.settings` (Admin), the pipeline stages (named tones, saved against the stages as loaded, "Move its N leads first"), scoring with every lead re-scored, response time, assignment at arrival (manual, round robin, one person), 0091 (numbered at merge; PR number at review)
- [C10a](as-built/C10a.md): the Sales role for leads: the enum value alone (0096), then the helpers, `app.is_member()` for `audit_insert`, the non-staff block, the no-role-claim trusted context, the legacy lead writes withdrawn, the directory and the guides (0097), the Sales column in §5 and architecture §3.4 (both parsed), the catalog-driven pgTAP, the Sales sweep (numbers assigned at merge; PR number at review)
- [C14a](as-built/C14a.md): the leads contract, part one (the code, no migration): `GET /api/admin/leads` and the `?pii=1` alias removed (the POST reveal is the one reveal), no Worker query naming `leads.status`, `internal_notes`, `ip_inet`, `timeline_band` or `crm_settings.timezone`, so the code runs on today's schema and on C14b's; the export keeps its PII rules (note counts, never note words; a legacy `?status=` link refused), the static gate `leadsContract.spec`, C14b's exact migration plan and the rollback floor it moves (PR number at review)
- [C14b](as-built/C14b.md): the leads contract, part two (the migration alone, held until C14a has deployed a day and applied before its merge): `leads.status`, `internal_notes`, `ip_inet`, `timeline_band` and `crm_settings.timezone` dropped after preconditions that count, never show, what would be lost; the legacy sync, the notes mirror, the backfill and the sync's helper gone; a lead naming no stage starts in the initial one; `leads_safe` re-created SECURITY INVOKER with its grants stated; the rollback floor moved to #109; 0113 (number at merge; PR number at review)
- [C4 star race](as-built/C4-star-race.md): a list read that left before a star was saved no longer draws it back off: on the list a row write (the star, a bulk action) aborts the read in flight and holds new ones, and the list is read once more when writes overlapped or one failed; a lead's page runs every read and write of the row in turn, busy until they land; every row write has a 15 s deadline (`src/lib/crm/lateAnswers.ts`); a failed board move reads the board again; no migration (PR number at review)

**Hotfixes**
- [H5](as-built/H5.md): the audit chain is serialized, 0031 (#36)
- [H6](as-built/H6.md): history rows are written by the snapshot trigger only, 0032 (#42)
- [H7](as-built/H7.md): a singleton's first save is accepted (#50)
- [H8](as-built/H8.md): RLS on every telemetry partition, SELECT only where staff only read, 0037 (#51)
- [H9](as-built/H9.md): lead notifications restored, signed and never silent, 0048; the staleDomain flake (#63)
- [H10](as-built/H10.md): a stale Admin token changes no profile, and an audit row names who wrote it, 0050 (#66)
- [H11](as-built/H11.md): the help-guide catalog: one row per guide, `app.help_article_set()` read from it, `app.put_help_guide`/`app.drop_help_guide` with a revision guard, so no slice restates the set, built as 0069 (number at merge; PR number at review)
- [H12](as-built/H12.md): Move up / Move down step over archived rows for a role that may not archive, and the reorder route refuses a request naming one (or another tenant's id) before writing anything, and with releases on a change that leaves a row archived is an Admin's to stage and publish; no migration (PR number at review)
- [H13](as-built/H13.md): the attention list is for CMS staff: `dashboard_attention` restated as 0066 left it, wrapped once in `app.is_staff()` (or the owner's session: no switched role, no role claim), grants stated, so a Sales token reads no row; the Sales pgTAP's last unfixtured relation gets its row, built as `0100_attention_staff.sql` (number at merge; PR number at review)
- [H15](as-built/H15.md): Tiptap and section content hardening: an article body (blog, service, project) is read by one iterative, bounded walk on write and on render (`readArticleDoc`, 5,000 nodes, 32 levels), never zod's recursive parse, and the renderer never throws; the service page and the case-study index map each row in its own guard; the blog page renders from the Tiptap source, never the stored `body_html` (a post with only the cache, the seed's, is read back by a strict reader of the renderer's markup, bounded like the walk); section content and draft payloads are depth-checked before they are stringified; a section write refuses a key its type does not have at any level, the read unchanged; the page editor's typed save drops a stray key at any level; no migration; `h15_prod_check_v2.sql` (Q2 and Q3) on production before merge (PR number at review)

**Wave 0**
- [W0-a](as-built/W0-a.md): CLAUDE.md §8 in bullets with one lane per track, the as-built files, the migration ledger, the runbook's rollback floor
- [W0-b](as-built/W0-b.md): endpoint cases per feature, the route coverage check, the renumber script
- [W0-c](as-built/W0-c.md): the admin registries, the screen stylesheets, the `Admin*` islands
- [W0-d](as-built/W0-d.md): the `contentClient()` seam and the cron job registry

**Closure**
- [Z1](as-built/Z1.md): the closing pass (AV-34): the per-role axe matrix with every dialog open (`tests/admin/dialogs.ts`, held complete by `adminDialogs.spec`; the shared confirm named by its question), the admin visual baselines at 1440 and 390 made and checked only by the hand-run `admin-visual.yml` (never a required gate), the TDD table and the acceptance scripts as built, the slice statuses, and the open owner items and legal holds in one list; no migration (PR number at review)
