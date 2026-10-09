# Admin v2: deviations register and TDD coverage

> The client's prototype (`admin.html`) and `ADMIN_TDD.md` are the product specification:
> "the prototype is the specification". This register lists every place the build
> deliberately differs, and why. A deviation exists only because the standard requires it
> (CLAUDE.md, cited) or because the owner decided it (A1 to A6, O-items in
> [README.md](README.md)). Owner item **O-13** asks for this register's approval. A slice that
> adds, removes or narrows a deviation edits this file in the same PR.

## Remaining deviations

- **Stack**: React islands + server routes, not the vanilla SPA or hash router; edge purge, not static regeneration; preview is a server render reloaded about 1 s after autosave, not per-keystroke `[data-i]` patching (§2, §3 CSP).
- **Roles** (A2/A4, RLS):
  - 5 roles;
  - no editable matrix, per-person grants or View as;
  - Developer gets no CRM (O-7);
  - Site health stays Admin + Developer.
- **Publishing**:
  - per area (P-2);
  - maintenance is immediate (Pillar 1);
  - media alt/tags are immediate (as in the prototype);
  - scheduling is per release.
- **Content**:
  - no HTML in copy (accent word ranges);
  - no Custom HTML section (§3 sanitizer/CSP);
  - no "show on mobile" (Pillar 3 parity);
  - testimonials need consent;
  - projects link the 28 real services;
  - a client's "Visible" is the disclosure permission;
  - archive/delete is Admin only.
- **Media**:
  - images only (video via Stream later, EXC-009);
  - no SVG/GIF;
  - originals are re-encoded;
  - no local blob previews (CSP).
- **Theme**:
  - no Google/Adobe font links or raw font uploads; the curated self-hosted catalogue replaces them (CSP, PDPL, font budget);
  - no Custom CSS;
  - no smooth scroll or parallax (compositor-only; design-port #44/#79);
  - colours must pass the contrast gate.
- **Header**: the language switch always shows (owner-approved product call, O-13).
- **Shortcuts**: the command palette opens on ⌘/Ctrl+K and from the topbar trigger, not on a bare "/". A one-character shortcut fires on a stray keypress or a dictated "slash", and WCAG 2.1.4 (Level A) requires it to be switchable off or remappable (DoD #4).
- **Footer**: legal links are locked (PDPL); copyright is a template (brand is data, §1).
- **Forms**:
  - closed field sets, no new fields (Zod boundary, per-column PII encryption);
  - the honeypot is always on;
  - recruitment consent is versioned.
- **Integrations**:
  - no secrets in staff-readable rows;
  - no API keys or outbound webhooks;
  - ad pixels wait for marketing consent (L6).
- **CRM**:
  - contact details behind an audited reveal; no budget in lists;
  - no client-side CSV;
  - Mark as spam + Admin-only Erase instead of delete;
  - no keystroke autosave;
  - retention is one horizon ≤ 24 months after last activity;
  - consent toggles, unsubscribe and Suggested reply/Send wait for L6.
- **Stats**:
  - referrer/UTM/device/country and unique visitors wait for L5 (legal);
  - "No cookie banner needed" is corrected (§7).
- **Backups**: leads are never in admin backups (DR via the runbook, §7/§10).
- **Activity log**: kept permanently and tamper-evident, not "12 months" or "90 days" (§3).
- **Invites** expire per Supabase Auth (≤ 24 h, with Resend) instead of 7 days, until L6 brings transactional email (O-22).
- **Health**: no in-Worker uptime checker; uptime comes from the external monitor (§10).
- **Copy corrected** where untrue:
  - maintenance "…after you publish";
  - "Kept for 90 days";
  - "Backups cover everything, including leads";
  - "nothing is saved until you publish" → "nothing goes live until you publish";
  - Health's "No CSP header".

## The client's TDD, row by row

Checked by the coverage reviewer against the three designs on 2026-10-03
([verification.md](verification.md)). "Verified" is that review's status. "After A6" is what
the program does with it: the owner's full-fidelity decision (A6) turned every
`deviated-challenge` row into a built slice, and every `missing` row became a slice. The
"Where" column uses design slice ids; README maps them to program slices.

| TDD § | Requirement | Verified (2026-10-03) | After A6 | Where (design ids) | Note |
|---|---|---|---|---|---|
| §2.1 | Every page, section, text, image, video window, order and visibility editable in EN+AR with live preview, draft and publish | covered | covered | AV-23, AV-25, AV-26, AV-31; R1-R12; P-3/P-4/P-5 | Core loop covered. Preview refreshes about 1 s after autosave (P-4, binding). The convenience gaps (section style settings, generic blocks, Shared text, New page) are separate rows below. |
| §2.2 | Services (5 disciplines, 28 services) and projects managed as records; public pages generated from them | covered | covered | existing disciplines/services/service_cases/portfolio + AV-14, AV-15, AV-31 | Public pages are Tier A SSR purged by tag, not generated files (§2). |
| §2.3 | Theme, header, footer, loading screen, logo and general settings applied to the site | covered | covered | AV-18, AV-27-AV-30, MERGE:header-options, P-9 | Storage must follow P-9 (site_appearance + footer on site_profile), not AV-28's site_chrome. Logo stays a code asset (owner item 7). |
| §2.4 | Leads into a CRM: contacts, companies, pipeline, tasks, PDPL consent | covered | covered | CRM-1-CRM-12, CRM-14 | Erasure, retention and audited reveal go further than the prototype on PDPL. |
| §2.4 | Inbox (email/WhatsApp), campaigns, broadcasts, automations, templates with approval, CRM reports, exports, ad audiences | deferred | later phase (A1) or legal gate | A1 later phase; CRM design §12 hooks | Consistent with A1. |
| §2.5 | Website statistics (built in plus Google Analytics) and a site health page | deviated-challenge | built under A6 | AV-10, AV-20 | v1 only. GA4 injection and the GA tab are deferred although A1 does not list them, and CLAUDE.md §2 locks 'GA4 secondary, behind consent'. |
| §2.6 | Seven roles, per-role and per-person permissions, View as | deviated-ok | deviation (standard or owner decision) | A2/A4 (binding); CRM-10; AV-21 read-only matrix | 4 roles + Sales. Per-person grants cannot be expressed in RLS (§3 two layers). |
| §2.6 | Invitations, activity log, backups and versions | covered | covered | AV-21, AV-22, R10, R13, AV-24 | 7-day invite expiry and scheduled backups are gaps (rows below). |
| §2.7 | Get connected centre with guided wizards | deferred | later phase (A1) or legal gate | A1 later phase | Consistent with A1. |
| §2.7 | In-app help centre | missing | added as a slice | none (UI design §0 lists Help centre as later) | A1 defers 'Get connected', not help; TDD §13 groups them, so the owner should say so explicitly. TDD wants articles in the DB. |
| §3.2 | Keep the vanilla SPA; REST API; static regeneration on publish; job-queue workers | deviated-ok | deviation (standard or owner decision) | P-1; CLAUDE.md §2 locked stack | Islands + Tier C SSR + Supabase RLS + Worker cron; purge-by-tag replaces regeneration. |
| §3.2 | save() (operational, immediate) vs dirty() (visitor content, waits for Publish) | covered | covered | P-3, R3 staged kernel, CRM §0 | Slice text contradicts P-3: AV-13 page visibility 'immediate', AV-19 redirects 'immediate', UI §7 media alt/tags 'draft'. Style-Finder is in neither P-3 list. |
| §5.1 | buildSeed() becomes a one-time DB seed for a populated staging | covered | covered | scripts/gen-seeds.mjs, seed.sql (staging), seeds/production.sql (drafts) |  |
| §5.2 | Hash router; PERM_ROUTES longest prefix; server enforces the same table | deviated-ok | deviation (standard or owner decision) | AV-03 (server routes, nav/ from ROLE_CAPS, 302 stubs); defineAdminRoute + RLS | Locked stack; lock empty state kept. |
| §5.3 | Bilingual values stored as {en,ar} JSONB, never split into two columns | deviated-ok | deviation (standard or owner decision) | CLAUDE.md §8 bilingual rule; AV-08 bilingual field | Standard: scalar -> _ar column, rich/array -> JSONB (repo is mixed: 0028 uses {en,ar} JSONB). Pairs are still edited together. |
| §5.4 | Field kit (rich bold/em highlight/link, video window {src,start,end,poster}, repeater, sortable, 25-row tables, charts, drawer, modal, toast, mediaPicker) | covered | covered | AV-04, AV-07, AV-08 | Stored HTML -> typed fields + AccentSchema + Tiptap (Pillar 1); window model kept (EXC-009); warn/error toasts become inline (WCAG). |
| §5.5 | Admin follows the theme live; simple palette from one colour; custom fonts (upload or link) | covered | covered | AV-27 | Google/Adobe links refused (Pillar 2 self-hosted fonts, CSP font-src 'self', PDPL). Uploads need the subset + metric-override pipeline. |
| §6.1 site | Identity: name, tagline, email, phone, WhatsApp, address, favicon, socials with visible flag | covered | covered | AV-18 (site_profile v2), P-3 staged |  |
| §6.1 site | langs, defaultLang, domain, timezone editable | deviated-ok | deviation (standard or owner decision) | AV-18 read-only facts | §2 i18n (both twins, x-default EN) and PUBLIC_SITE_URL canonicals. crm_settings.timezone (CRM-9) is editable: keep one source. |
| §6.1 site | logo and logoDark editable | deviated-ok | deviation (standard or owner decision) | AV-18 (owner item 7) | Home LCP element (§6). A bounded slice with an lhci re-gate is possible later. |
| §6.1 site.maint | Maintenance copy {en,ar}, background, contact buttons, 'Back on' auto-off, show date, allowTeam toggle, allowIps | deviated-challenge | built under A6 | src/middleware.ts IP allowlist + MERGE:maint-bypass; AV-18 defers the rest | The 'no DB on the critical path' concern is met by putting the copy in the same KV value as the flag. |
| §6.1 theme | Colours: simple (opsPalette) and advanced | covered | covered | AV-27 | The contrast gate may adjust generated colours (DoD #4). |
| §6.1 theme | headingWeight, uppercase, radius, buttonStyle | deviated-challenge | built under A6 | AV-32 (later, owner item 9) | Not in A1's later list. |
| §6.1 theme | smoothScroll (Lenis), parallax | deviated-ok | deviation (standard or owner decision) | AV-27 read-only facts | design-port #44/#79; compositor-only animation (§3 Pillar 2). |
| §6.1 theme | reveal, reduceMotion, marquee speed toggles | deviated-challenge | built under A6 | AV-27 (facts only) | These only reduce motion; a site-wide reduce switch would partly answer EXC-007. |
| §6.1 theme | Custom CSS | deviated-ok | deviation (standard or owner decision) | none | §3 CSP / ThemeTokensSchema. |
| §6.1 header | Items order/visible/key, alignment, logo position, logo size, hide on scroll, CTA, mobile menu | covered | covered | AV-28 + MERGE:header-options; P-9 site_appearance |  |
| §6.1 header | Transparency 0-100, blur 0-30, solid after hero, sticky, show language switch | deviated-challenge | built under A6 | AV-28 read-only facts | Bucketed data attributes are CSP-safe. 'Language switch always on' is a product call, not a § rule. |
| §6.1 footer | Copyright, style light/dark, show email, show social, columns of page links | covered | covered | AV-29; P-9 (site_profile) | Copyright template (§1 brand is data) and locked legal links (PDPL) are standard-based. |
| §6.1 loading | Enabled, style, duration, fade, once only | covered | covered | AV-30 | 500-1500 ms follows the prototype's own 'never longer than 1.5 s'. Once per tab = TDD 'once per session' (prototype hint says 'per browser'). |
| §6.1 loading | 'bar' and 'text' styles, tagline, light background | deviated-challenge | built under A6 | AV-30 (not built) | A scaleX bar is compositor-only; the tagline needs an lhci re-gate, not a refusal. |
| §6.1 seo | Per-page title/description/OG/index; default OG; robots | covered | covered | AV-19 (entity_seo list + SeoDrawer, og_media_id), P-3 |  |
| §6.1 seo | Sitemap and structured-data toggles; one canonical URL | deviated-ok | deviation (standard or owner decision) | AV-19 read-only rows | Pillar 3: code-owned sitemap/JSON-LD, per-language canonicals. |
| §6.1 forms | Field labels, visible, required, order, budget ranges, button text | covered | covered | MERGE:forms-config; P-3 | Must make server-side 'required' follow config, purge form-page tags and version any consent copy. P-2 names no publishing area and §5 has no row for it. |
| §6.1 forms | Add custom fields; honeypot toggle | deviated-ok | deviation (standard or owner decision) | MERGE:forms-config (closed field sets) | §8 Zod single boundary; Pillar 1. |
| §6.1 forms | Captcha | missing | added as a slice | none (src/pages/api/contact.ts:65 TODO KAN-20) | Not provisioned. The honeypot and the EXC-004 limiter remain. |
| §6.1 leadSettings | Editable statuses (label, colour), assignment rule, SLA hours | covered | covered | CRM-1, CRM-9 | Fixed tones instead of hex (challenged). TDD 'by-service' is not in the prototype (manual/round-robin/fixed), so the prototype wins. |
| §6.1 leadSettings.notify | Team e-mail/WhatsApp alerts, auto reply, Slack webhook | deferred | later phase (A1) or legal gate | A1 (no outbound); AV-20 bell preferences | Consistent with A1. |
| §6.1 ga/pixels | GA4 id/anonymize/events and Meta/TikTok/Snap pixels injected when set | deviated-challenge | built under A6 | AV-20 stores the GA4 id only | GA4 behind hasConsent is a locked decision; needs a CSP amendment. Pixels belong with ad audiences (A1 later): owner. |
| §6.1 integrations | Email, WhatsApp, Sheets, Slack, HubSpot, inbound, calendar, Meta; setupState; secrets masked | deferred | later phase (A1) or legal gate | A1 later; AV-20 typed GA4/Search Console/Calendly/reCAPTCHA | Secrets never in a staff-readable row (§7) is honoured. |
| §6.2 content/raw | Flat map of 253 bilingual keys + raw values shared with the site | covered | covered | AV-23, AV-25 | Typed section fields replace data-i keys. Add a key inventory test: every seed_home/seed_pages key maps to a field or a documented code-owned exception. |
| §6.2 pages | Section label, visible, order | covered | covered | AV-25 (page_sections.label) |  |
| §6.2 pages | Section background, spacing, reveal, show on mobile, anchor | deviated-challenge | built under A6 | AV-25 (not offered) | Closed variants are CSP-safe; only 'show on mobile' has a Pillar 3 parity argument. |
| §6.2 pages | New pages created from the editor (hero + text block) | deviated-challenge | built under A6 | AV-33 (later, owner item 9) | Not in A1's later list. |
| §6.2 cats/services | Disciplines, services, case, clip windows, SEO | covered | covered | AV-14, AV-19 | Prototype caps value cards at 4 and problems at 5 (repo 6): tighten the admin schema. Case client derived from the project. |
| §6.2 projects | Project record incl. hero, final film, breakdown, gallery, keywords, quote, featured | covered | covered | AV-15 | Inline quote -> linked testimonial with consent (§8 gate); free service tags -> the 28 services. |
| §6.2 collections | Taxonomies, testimonials, clients, team, FAQ, joinWhy/joinSteps | covered | covered | AV-15, AV-16 (faq_items), AV-25 (join items) | Client 'visible' is the disclosure permission (§8). |
| §6.2 media | Image library: upload, search, tags, where-used | covered | covered | AV-11, AV-12, R5 (media_usage v4 incl. drafts) |  |
| §6.2/§8.6 media | Video uploads up to 500 MB with poster frames | deferred | later phase (A1) or legal gate | A5 | Video later with Stream. |
| §8.6 | Signed direct uploads, 25 MB images, variants generated on upload | deviated-ok | deviation (standard or owner decision) | AV-11 | Worker-mediated upload sniffs bytes before storing (Pillar 1); variants via /_image. The 10 MB cap itself has no standard basis (challenged). |
| §17 | Image re-encoding on upload | missing | added as a slice | none (AV-11 stores originals) | EXIF/GPS stay public at the original bucket URL. |
| §6.3 leads | Lead record with assigned, value, score, starred, read, notes, timeline, contactId | covered | covered | CRM-1-CRM-4 |  |
| §6.3 leads | page, utm, device, country, city captured on each lead | deviated-ok | deviation (standard or owner decision) | CRM-13 (legal + consent gated) | PDPL + hasConsent basis; landing_path server-derived; city never stored (minimisation, O4). |
| §6.3 crm.contacts | Contacts with stage, tags, owner, custom fields, star, last activity | covered | covered | CRM-5-CRM-7, CRM-9 | Contact stages fixed: the prototype says 'Fixed', so the TDD's 'editable' loses. |
| §6.3 crm.contacts | Consent flags with timestamp, unsubscribed | deferred | later phase (A1) or legal gate | A1; CRM §12 consent events | No channel sends now. |
| §6.3 crm.companies | Companies | covered | covered | CRM-11 |  |
| §6.3 crm.tasks | Tasks (call/email/whatsapp/meeting/todo) | covered | covered | CRM-8 |  |
| §6.3 messaging | Conversations, templates, segments, campaigns, automations, exports log, messaging and automation settings | deferred | later phase (A1) or legal gate | A1 | Consistent with A1. |
| §6.4 users | People list with email, last seen, active | covered | covered | AV-21 |  |
| §6.4 users | TOTP 2FA, require 2FA, reset 2FA | deviated-challenge | built under A6 | AV-05/AV-21 hide 2FA | Supabase Auth MFA exists and raises Pillar 1. |
| §6.4/§7 invites | Invitation links that expire in 7 days | missing | added as a slice | AV-21 (inviteUserByEmail resend/cancel) | Supabase invite links follow the global Email OTP expiry (default 1 h; more than one day is discouraged and Management-API only). |
| §6.4 | rolePerms, userPerms, session.viewRole | deviated-ok | deviation (standard or owner decision) | A2/A4 | Binding. |
| §6.4 dash | Per-person layout and quick actions | covered | covered | AV-05 (admin_user_prefs), AV-09 |  |
| §15 | Quick actions can be pre-set per role by the owner | missing | added as a slice | AV-09 (per-role default layouts only) | TDD-only: the prototype has one global QUICK_DEFAULT (screens_cms.js:162). |
| §6.4 activity | Append-only, kept 12 months | deviated-ok | deviation (standard or owner decision) | audit_log; AV-22 | CLAUDE.md §3/§7: no DELETE, exempt from retention (the prototype says 90 days, screens_ops.js:1094). |
| §6.4 versions | One version per publish storing the full content snapshot for Restore | deviated-challenge | built under A6 | R1, R4, R10 | Row-level capture + as-of computation. Out-of-band writes are neither guarded nor captured, which breaks Restore (see missed details). |
| §6.4 notifications | In-app bell with read state | covered | covered | AV-05 | Derived feed; read state is one watermark, not per item. |
| §6.4/§15 backups | Daily automatic (keep 30), manual, downloadable, restorable | deviated-challenge | built under A6 | AV-24/R13 export-backup; DR runbook (§10) | No leads in admin backups (§7) is standard; scheduled content snapshots are not barred. |
| §7 | Every endpoint declares its permission; 403 server-side | covered | covered | defineAdminRoute/assertCap + RLS; endpoints.spec over all roles incl. sales, other_tenant |  |
| §7 | An owner cannot be downgraded by an admin | missing | added as a slice | src/pages/api/admin/users/[id].ts refuses only self-demotion | Any Admin can demote the principal Admin. An owner marker needs no new role. |
| §7 | Email + password, session cookie, login rate limiting | covered | covered | existing lockout (5/15 min -> 423), AV-06 |  |
| §7 | Sales = leads + stats | deviated-challenge | built under A6 | CRM-10 (no analytics.read) | §5 gives analytics.read to every current role; aggregates carry no PII. |
| §8.1 | Three-column editor; drag reorder, eye, rename, remove, add section | covered | covered | AV-25 | Remove is Admin-only (§5 archive/delete). |
| §8.1 | SECTION_LIBRARY generic blocks (text, gallery, video, CTA, custom HTML) | deviated-challenge | built under A6 | AV-25 typed types; AV-33 textBlock | Refusing Custom HTML (Pillar 1) is right; Gallery/Video/Text are ordinary typed types. |
| §8.1 | Preview updates at once while typing | deviated-ok | deviation (standard or owner decision) | P-4; R9; AV-26 | Binding. |
| §8.1 | Template pages: 'Showing' picker + the record's own content | covered | covered | AV-31 |  |
| §8.1 | Template 'Shared text' (v.*, p.*) editable | deviated-challenge | built under A6 | AV-31 (read-only) | Labels are code today, not by rule. |
| §8.2 | public / hidden (404, leaves menu) / link only; homepage cannot be hidden; per-item visible | covered | covered | AV-13 + MERGE:link-only; P-2/P-3 | AV-13 says immediate but P-3 stages it: the visibility KV snapshot must be re-synced after apply and rollback (R7 syncs redirects only). |
| §8.2 | Password gate, redirect to another page, hide-from/until dates, template-wide hide | deviated-challenge | built under A6 | none (AV-13: 404 or home only) | All feasible pre-cache in the Worker (see challenges). |
| §8.2 | Maintenance for all visitors except signed-in team and allowed IPs; 503 + Retry-After | covered | covered | src/middleware.ts:137-149, src/lib/http/maintenance.ts:100, MERGE:maint-bypass | Immediate kill switch vs the prototype's 'after you publish' is a Pillar 1 call. |
| §8.3 | Publish copies draft to live, bumps the version, refreshes site output | covered | covered | R4, R6, R7 | Purge by tag, never a rebuild (§2). |
| §8.3 | Unsaved bar; Discard restores the draft from live | covered | covered | R3 draft endpoints, R12, AV-24 | Scopes: one / mine / chosen. AV-24 copy ('everything since the last publish') must match R12. |
| §8.3 | Page History restores one page's keys from a snapshot | deviated-challenge | built under A6 | R10 (per entity + site-level) | A page is a page row plus its sections; needs a page-scoped restore. |
| §8.4 | Static regeneration (option A) or runtime fetch (option B) | deviated-ok | deviation (standard or owner decision) | §2 Tier A + purge (R7) |  |
| §8.4 | Site renders theme, header, footer, loading, maintenance, visibility, SEO tags, forms | covered | covered | AV-13, AV-19, AV-27-AV-30, MERGE:forms-config |  |
| §8.4 | Site renders pixels and GA | deviated-challenge | built under A6 | none | See the GA4/pixels row. |
| §8.5 | Services/projects screens and tabs; reordering renumbers; featured pickers | covered | covered | AV-14, AV-15 | The number pill derives from disciplines.sort_order. |
| §8.6 | Library, picker in every image field, where-used before delete | covered | covered | AV-12, R5 |  |
| §9 | postMessage bridge (text/texts/lang/show/order/jump/item), ready handshake, origin checks, draft rendering | deviated-ok | deviation (standard or owner decision) | R8, R9, AV-26 (P-4) | Reload + jump/highlight/tokens instead of text patching; bridge only on /admin/preview (Pillar 1/2). R9 and AV-26 name different bridge and envelope files: keep one. |
| §10 | Theme fields mapped to the site's CSS variables | covered | covered | AV-27 (colours, theme.css); AV-32 shapes/type later |  |
| §10 | Header, footer, loading settings rendered on the site, with previews | covered | covered | AV-28-AV-30 | Real iframe preview instead of mock previews. |
| §11.1 | Form endpoints validate against config, honeypot, captcha, IP rate limit | covered | covered | /api/contact, /api/apply, EXC-004 limiter, MERGE:forms-config | Captcha missing (KAN-20). |
| §11.1 | Create lead (first status, score), find/create contact, assign, in-app notification, SLA clock | covered | covered | CRM-1, CRM-5, CRM-9, CRM-4, AV-05 |  |
| §11.1 | Find or create the company on submit | missing | added as a slice | CRM-11 (manual only) |  |
| §11.1 | Record consent with timestamp | covered | covered | leads.consent_marketing (consent to reply) | Store the consent copy version once Forms config makes it editable (PDPL). |
| §11.1 | Team notification, auto reply, inbox conversation, form_sent trigger | deferred | later phase (A1) or legal gate | A1 |  |
| §11.2 | Leads list (filters, bulk, export), board (drag), detail; moves logged | covered | covered | CRM-2-CRM-4 | No budget column, server-only export, no bulk delete (§3/§7); keyboard Move to. |
| §11.2 | Convert to contact; open conversation | covered | covered | CRM-5 auto-link; inbox A1 |  |
| §11.2 | Lead scoring recomputed on every event | covered | covered | CRM-1, CRM-9 | Closed signals = what the prototype actually evaluates (cxScoreWhy); behavioural signals come later. |
| §12.1 | Inbox and the WhatsApp 24-hour rule | deferred | later phase (A1) or legal gate | A1 |  |
| §12.2 | Contacts/companies, search, merge, bulk tag, detail, custom fields, timeline, star | covered | covered | CRM-5-CRM-7, CRM-11, CRM-12 |  |
| §12.2 | Import CSV with column mapping and duplicate detection | deviated-challenge | built under A6 | CRM §12 hook (owner O12) | Not in A1's later list. |
| §12.2 | Match on e-mail, then phone normalised to E.164 | deviated-challenge | built under A6 | CRM-5 (phones go to the merge finder) | A data-quality call, not a standard rule. |
| §12.2 | Consent toggles, unsubscribe, contact export | deferred | later phase (A1) or legal gate | A1 |  |
| §12.2 (prototype) | Contact Files card | deviated-challenge | built under A6 | none (CRM deviation 15) | The private-bucket + audited-download pattern already exists (applications). |
| §12.3-§12.7 | Templates, campaigns, automations, global rules, reports, exports, audiences, consent log | deferred | later phase (A1) or legal gate | A1 |  |
| §13 | Get connected list, wizards, banners, dashboard setup note | deferred | later phase (A1) or legal gate | A1 |  |
| §13 | Help centre: ? button, search, guides, per-screen Guide, articles editable in the DB | missing | added as a slice | none | See §2.7. |
| §14 | First-party beacon with no cookies | deviated-ok | deviation (standard or owner decision) | /api/analytics (hasConsent) | §2/§7 consent-gated; the 'no cookie banner' copy is corrected. |
| §14 | Events, funnel, goals, realtime, sessions | deviated-challenge | built under A6 | AV-10 (later) | Feasible on consented data; realtime needs a 1-minute rollup (Pillar 4). |
| §14 | Sources, countries, devices, browsers, unique visitors, cities | deviated-ok | deviation (standard or owner decision) | AV-10 (later) | Consent-gated capture + notice change (PDPL, O4); a persistent visitor id needs legal; cities never. |
| §14 | GA4 numbers via the Data API (/stats/ga) | deviated-challenge | built under A6 | none |  |
| §14 | 10-minute health worker (uptime, TTFB, weight, errors, broken links, SSL/domain, headers, SEO, synthetic form, backup, storage), score, alerts | deviated-challenge | built under A6 | AV-10 v1 | Vitals, errors, checklist, security, SEO, backup, storage now. Uptime must come from the external monitor (§10): integrate its API. |
| §14 | Health visible to every 'stats' role | deviated-ok | deviation (standard or owner decision) | AV-10 (siteHealth.view) | §5: Admin + Developer. |
| §15 | Twelve widgets, per-user layout, Customize across three columns | covered | covered | AV-09 | Realtime and Team notes omitted (challenged). |
| §15 | Users: invite with role, deactivate, reset 2FA, editable matrix, personal access | covered | covered | AV-21 | Read-only matrix and no personal access (binding); reset 2FA missing. |
| §15 | Activity log filterable by person, action and date; exportable | deviated-challenge | built under A6 | AV-22 (kind chips + q; no export) |  |
| §15 | Publish versions list with restore | covered | covered | R10, R13, AV-24 |  |
| §16 | REST/JSON, session cookie, CSRF on writes, per-route permission | covered | covered | defineAdminRoute, __Host-csrf, assertCap | /state bootstrap and /site/*.json are not needed (SSR, P-1). |
| §16 | /auth/2fa and /auth/invite/:token | missing | added as a slice | none | Follows the 2FA and 7-day invite gaps. |
| §16 | Workers: rollups, backups, health checks, link crawl, senders, sheets sync | covered | covered | existing pg_cron rollups + AV-10 rollup_vitals; R7/R11 minute cron; §10 DR | Senders/sheets are A1; health from the external monitor; a crawl does not fit the free plan's 10 ms cron CPU. |
| §17 | Phases 1-3: foundation, CMS live, leads | covered | covered | R0-R16, AV-01-AV-31, CRM-1-CRM-14 | Phase-3 notifications/auto reply/inbox threads (A1) and import (O12) excluded. |
| §17 | Phases 4-7: email, WhatsApp, automations, growth | deferred | later phase (A1) or legal gate | A1 (4-6); phase 7 partly outside A1 | GA4, Search Console, beacon enrichment, health worker and editable help need owner confirmation. |
| §17 | Security basics (HTTPS, HttpOnly, CSRF, permission checks, rate limits, upload validation, masked secrets, audit, off-site backups, consent log, export audit, deletion on request) | covered | covered | existing standard + AV-11, CRM-3/CRM-5 | Image re-encoding missing; the marketing consent log is deferred (A1). |
| §17 | Admin English; content EN+AR; Almarai + dir=rtl on AR editors | covered | covered | AV-02, AV-08, UI §1.5 |  |
| §17 | Eastern Arabic digits in content are never transformed | missing | added as a slice | none | No design states it and no test guards it. |
| §19 | Prototype shortcuts replaced (secrets, uploads, role checks, stats, login, placeholders) | covered | covered | AV-06, AV-11, AV-20, RLS + assertCap, rollups, 0025/0027/0028 guards | Placeholders: the replace-and-clear flow; production refuses live samples unless the owner override (runbook §6c). |

## The client's acceptance scripts

How each script in the handoff's `src/tests` maps onto this build. README's
"Verification (end to end)" holds the TDD §18 acceptance list.

| Acceptance script item | Design slices | Passes as designed | What replaces it |
|---|---|---|---|
| adfull.mjs: every route for every role, zero page/console errors, no horizontal overflow, sidebar per role, state survives reload (plus editor live text, hide/reorder/add section, AR switch, mobile preview, publish, palette, notifications, View as, demo-chip login, file://) | R0/AV-01 (P-8), AV-03, AV-04, AV-05, AV-25, AV-26, R9, R12, AV-34, CRM-10 | partly | Per-role storageState sessions replace the View-as select and the demo chips (A2/A4, AV-06). Run on staging over https, not file://. 'State survives reload' becomes 'server drafts survive reload' (R3). Preview assertions wait for the post-autosave reload (about 1-2 s, P-4). 'Add section' picks an allowed typed type. Add zero console errors and scrollWidth <= clientWidth + 2 per admin route and role to the harness: AV-34 only plans axe and screenshots. |
| crmall.mjs: inbox reply and template, contact merge and import, campaign wizard, automation builder, export with consent counts; lead-to-contact link; role nav; palette finds a contact and a campaign | CRM-4, CRM-7, CRM-10, CRM-12 | partly | A core-only script: leads list/board/detail, lead -> contact link, contact merge, tasks, Sales nav = Dashboard/Leads/Contacts/Tasks. Inbox, template, campaign, automation, export and import go to the later-phase acceptance. The marketer/account roles do not exist (A2). Palette contact search passes only if the ⌘K challenge is accepted. |
| su.mjs: DNS verify, email connected, WhatsApp wizard, banners disappear, help centre search, automation rules, run log, editor cannot see setup | none (A1 later); help centre unassigned | no | Later-phase acceptance. Now: 'Content Creator sees no Integrations/Users/General nav and gets 403 by URL' (adminSecurity.spec + endpoints.spec). Help-centre search only if the help centre is scheduled. |
| tpl2.mjs / pvchk.mjs / filechk.mjs: template page editor and live preview over http and from disk | AV-31, AV-26, R8, R9 | partly | https on staging only: an authenticated SSR admin cannot run from disk. The edit must appear in /admin/preview after the autosave reload (about 1-2 s), not after 400 ms. Switching the 'Showing' item reloads /admin/preview/services/<slug> or /portfolio/<slug>. |
| sitechk.mjs / allsite.mjs: every site page loads clean, with the preview hook present | R9 preview-isolation + existing e2e/lhci | partly | Inverted on purpose: public pages must load clean (no console errors or overflow, EN+AR) and must NOT reference the bridge. The /admin/preview route must carry it (preview-isolation.e2e). |
| A real form submission appears as a lead within 5 seconds, with notifications delivered | CRM-1 (crm_ingest_lead), CRM-4, AV-05, existing notify-lead | partly | The lead shows in /admin/leads within 5 s and in the bell count on the next render; a notification_log row is written ('queued'). No e-mail or WhatsApp delivery under A1 (CLAUDE.md §10: notify-lead sends nothing yet). |
| An edit to the homepage headline is visible on the public site after Publish and not before | AV-25, R3, R6, R12, R14 switch-on | yes | Point releases-publish.e2e at the homepage headline literally. Valid only after app.enable_releases (flag on); before R14, a save goes live at once. |
| A hidden page returns 404 and leaves the menu | AV-13 (staged per P-3, published under maintenance.manage per P-2), MERGE:link-only | yes | Under P-3 the hide takes effect when published. Also assert sitemap/llms exclusion and the visibility KV re-sync after the release and after a rollback. |
| Maintenance returns 503 to visitors and lets a signed-in admin through | src/middleware.ts + src/lib/http/maintenance.ts (503, Retry-After), MERGE:maint-bypass | yes | New e2e: anon gets 503 with Retry-After and no-store; a staff session cookie gets the public page; the IP allowlist keeps working; the bypass fails closed when the session cannot be verified. |
| An email campaign to a test segment delivers with a working unsubscribe | none (A1 later) | no | Moves to the later-phase acceptance; nothing replaces it now. |
| A WhatsApp reply outside 24 hours is blocked without a template and allowed with one | none (A1 later) | no | Moves to the later-phase acceptance. |
| An automation with a 3-day wait sends on time in Asia/Riyadh | none (A1 later) | no | Time-zone proxies now: a scheduled release fires on time in Riyadh time (R11 releases-schedule.e2e), and task Today/Overdue grouping follows the Riyadh day boundary (CRM-8). The real check moves to the later phase. |
| A sales user cannot open /settings/users by URL or by API | CRM-10 (crm-roles.e2e, endpoints.spec), AV-21, AV-03 lock state | yes | The route is /admin/users. Assert the server-rendered lock page, a 403 from /api/admin/users, and 0 rows through PostgREST. |
| A backup restores a deleted project | R10 (Restore vN re-creates deleted entities with portfolio children), R4 capture; DR runbook (§10) | partly | There is no backup-restore button (§7/§10). New acceptance: delete a project in release N, Restore v(N-1), preview, publish -> the project and its portfolio_services/portfolio_media return with the same id. A full-database restore is proven by the quarterly DR drill. |

## Per-design lists

Each design ends with its own "Deviations from the prototype" list, written before the
program decisions: [ui.md](ui.md), [releases.md](releases.md), [crm.md](crm.md). Where one of
them disagrees with the register above, the register wins.
