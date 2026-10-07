# CRM core (A1) and the Sales role (A4): Admin v2 architecture

> **Status: design input to the Admin v2 program, written 2026-10-03.** Where this
> document and [README.md](README.md) disagree, README wins: its program decisions
> (P-1 to P-15) and the adversarial review in [verification.md](verification.md) were
> applied after this design was written. Design slice ids (CRM-1 to CRM-14) map to program
> slices in README's slice tables. Inputs it cites by file name (design.txt, grp-*.txt,
> linkage.txt, code-summaries.txt) were working notes of the mapping pass and are not
> in the repository; the client's prototype and ADMIN_TDD.md are the handoff.

## Summary

The CRM core gets its own tables beside the existing leads data, and Sales comes in as a fifth role right after that. Leads v2 replaces the status CHECK with a per-tenant lead_stages table. Stage labels, tones, order and kind (open/won/lost) are editable, colours come from a fixed CSP-safe palette, and every lead points at its stage through a (tenant_id, stage_id) composite foreign key. Spam stays a system flag (is_spam). A trigger now actually applies the documented spam_days limit to retention: purge_leads never checked spam, so spam was being kept 24 months. Lead notes move from the single internal_notes column to an append-only lead_notes table gated by leads.pii. A product timeline (lead_events) is written by database triggers, kept separate from the audit log. Staff UPDATE on leads is narrowed to a column grant; today any lead worker can rewrite email_enc or retention_delete_after through PostgREST. Every table holding personal data also gets a RESTRICTIVE live check (app.live_role(), modelled on is_live_admin), which closes the stale-token gap for leads and the whole CRM. Contacts are created and linked when a lead arrives, matched by an HMAC blind index derived from a labelled LEAD_PII_ENC_KEY (no new secret). Contact details appear only through a per-record reveal that is audited fail-closed and rate-limited, and they are never shown in lists, search or the command palette. Erasure is Admin-only (crm.erase): it is audited before acting and deletes the person's leads, notes, tasks and contact in one service-role transaction, so no lead PII is left orphaned. Tasks are grouped by Asia/Riyadh day on the server, with a server-generated .ics file and a my-overdue badge in the sidebar. CRM settings covers stages, scoring (a fixed set of signals with editable points), up to 12 custom fields, response time and assignment. Messaging settings, consent events, import, segments, inbox and templates are designed as hooks but not built. Sales gets leads.manage, leads.pii (one lead at a time, audited, rate-limited), crm.contacts and crm.tasks. It gets no content, settings, exports, applications, logs/audit, site health, users, analytics, erasure or bulk PII. On the database side that is an ALTER TYPE in a migration file of its own, followed by one-line edits to one SQL helper per capability. app.is_staff() stays the CMS-staff check, and a new app.is_member() lets Sales write audit rows. While reading the code I found ten existing defects (unaudited PII reveal possible, spam never purged early, over-broad grants, notes data loss, stale-token reads, a role-matrix snapshot test that checks only CLAUDE.md §5). Each one is fixed inside a slice. The work is 14 PR-sized slices: leads (schema, read API, write API, UI), contacts (schema, API, UI), tasks, settings, then the Sales role, then companies, merge, attribution and the contract migration.

Sources read: grp-crm.txt, grp-leads-stats-appearance.txt (leads list/board/detail), grp-shell-dashboard.txt, grp-marketing.txt (Templates/Reports/Export hooks), code-summaries.txt. Repo: supabase/migrations 0001, 0002, 0004, 0008, 0009, 0010, 0011, 0015, 0017, 0019, 0022, 0028, 0029; src/pages/api/admin/leads/{index,[id],export}.ts; src/pages/api/admin/applications/[id].ts; src/lib/admin/{route,audit,liveRecheck,rateLimit,leadFields,nav,globalSearch,crud,backupTables}.ts; src/lib/data/leads.ts; src/pages/api/contact.ts; src/pages/api/hooks/notify-lead.ts; src/lib/crypto/pii.ts; src/lib/applications/keys.ts; src/lib/http/publicRateLimit.ts; src/lib/auth/{types,context}.ts; src/lib/authz/matrix.ts; src/lib/cron/daily.ts; src/components/admin/{LeadsPanel,UsersPanel}.tsx; tests/authz/{matrix,endpoints}.spec.ts; tests/lib/adminSecurity.spec.ts; supabase/tests/{rls_leads,rls_job_applications}.test.sql; docs/{architecture,retention}.md; .size-limit.json; .github/workflows/{ci,db-tests}.yml.

## 0. Rules that apply to every slice

- **CRM data is operational data, never content.** It is never staged into the A3 site-wide release, never part of a release snapshot or preview, and never in content backups (add every CRM table to `FORBIDDEN_BACKUP_TABLES`). The unpublished-changes bar never appears on CRM screens. Every CRM write takes effect at once, is versioned (`version`, 409 on a mismatch) and is audited. CRM settings also apply at once, because nothing public reads them.
- **Maintenance mode.** I agree with the note: it stays an immediate, confirmed switch outside the release. A Pillar-1 kill switch that waits for a Publish is not a kill switch (§3 Pillar 1: Worker-level pre-cache check).
- **Default-deny is structural.** Every existing policy names its roles explicitly (`app.is_staff()` names four; the lead policies name admin and developer). A new enum value therefore gets nothing until a CRM helper names it (§5: "When in doubt, default-deny").
- **Two layers, both pass (§3 Pillar 1):**
  - RLS, through one SQL helper per capability, plus a RESTRICTIVE live check on every table that holds personal data;
  - `assertCap` in `defineAdminRoute`;
  - `liveRecheck` on every reveal, erase and other privileged service-role path.
- **Pillar order** settles every conflict with the mockup. The full list is under deviationsFromMockup.

## 1. Existing defects found (each fixed inside a slice)

| # | Defect | Evidence | Fixed in |
|---|---|---|---|
| D1 | The `lead.view_pii` audit is queued. The kernel ignores `writeAudit`'s `false`, so contact details can be decrypted with no audit row written. This contradicts the handler's own comment and §3 ("audit-log every view"). `applications/[id].ts` does it correctly: a direct `writeAudit`, refusing on `false`. | src/lib/admin/route.ts (`for (const entry of pending) await writeAudit(...)`); leads/[id].ts | CRM-2: the reveal becomes a POST that writes the audit row directly before decrypting and answers 403 if it can't. The legacy `?pii=1` gets the same treatment until it is removed (CRM-14). |
| D2 | `spam_days` (30) is documented in docs/retention.md, site_settings and the Zod schema, but `app.purge_leads()` ignores status. Spam leads live 24 months. | 0008:106-125 | CRM-1: an `is_spam` trigger caps `retention_delete_after` at now() + spam_days (the 0029 job-application pattern). |
| D3 | `authenticated` holds table-wide UPDATE on `leads`. Any lead worker can rewrite `email_enc`, extend `retention_delete_after` or flip `consent_marketing` through PostgREST. | 0011 §5d | CRM-1: a column-scoped UPDATE grant. |
| D4 | LeadsPanel fills the notes textarea only after the `?pii=1` reveal. Saving without revealing overwrites `internal_notes` with ''. | LeadsPanel.tsx `open()` / notes | CRM-1/2: an append-only `lead_notes` table; PATCH `internalNotes` is refused from CRM-2. |
| D5 | Stale-token gap on leads: a demoted or deactivated Developer's token still reads leads, including plaintext `internal_notes`, for up to an hour through PostgREST. | 0029 fixed applications only | CRM-1: a RESTRICTIVE live policy on leads and on every CRM table. |
| D6 | The "byte-for-byte across §5, architecture §3.4, its ROLE_CAPS block and §9.3" CI claim holds only for CLAUDE.md §5. `tests/authz/matrix.spec.ts` parses CLAUDE.md alone. Architecture §3.4 already drifts: ●/○/◐ notation, different labels, and a stale code block (`leads.sensitive`, `content.read`). §9.3 is prose. | tests/authz/matrix.spec.ts; docs/architecture.md §3.4 | CRM-10: §3.4 is rewritten in the §5 format and parsed by the same test; the code block becomes a pointer to matrix.ts; §9.3 points at endpoints.spec. |
| D7 | CLAUDE.md §3 says `leads_safe`'s GRANT "is not to all authenticated". That has been false since 0002/0011: all app roles share `authenticated`, so `security_invoker` plus RLS is the actual control. | 0011 header | CRM-1 amendment. |
| D8 | Hard-coded role lists: UsersPanel `ROLES`, notify-lead `RECIPIENT_ROLES`, and the adminSecurity.spec lead roles. | grep | CRM-10: derive them from `ROLES` / `ROLE_CAPS`. |
| D9 | Lead search covers names only. Extending it to company or message with PostgREST `.or()` would break the single-column search-safety rule (globalSearch.ts, §9(e)). | leads/index.ts | CRM-2: an INVOKER RPC over a generated `search_text` column (pg_trgm). |
| D10 | Search terms travel in GET query strings, so a typed e-mail address lands in URLs, browser history and Worker request logs. | none | CRM-2: query endpoints take a POST body; the page URL never keeps `q`. |

## 2. Capabilities and roles

### 2.1 Matrix changes

Labels are the strings `matrix.spec` parses. Every other §5 row gets Sales = ❌.

| Capability / Area (label) | cap id | Admin | Content Creator | SEO | Developer | Sales | Slice |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| Leads — view list / pipeline / assign / timeline | leads.manage (relabelled) | ✅ | ❌ | ❌ | ✅ | ✅ | label CRM-1, Sales CRM-10 |
| Leads — contact details, budget, timeline, notes (PII, one lead at a time, audited) | leads.pii (relabelled: the notes thread joins it; `ip` leaves the label because it is never written) | ✅ | ❌ | ❌ | ✅ | ✅ (owner item O1) | CRM-1 / CRM-10 |
| Leads / analytics — export CSV | export.csv | ✅ | ❌ | ❌ | ✅ | ❌ | unchanged |
| CRM — contacts & companies (view, add, edit, notes, merge) | crm.contacts | ✅ | ❌ | ❌ | ❌ (O2) | ✅ | CRM-5 / CRM-10 |
| CRM — tasks | crm.tasks | ✅ | ❌ | ❌ | ❌ | ✅ | CRM-8 / CRM-10 |
| CRM — settings (pipeline stages, scoring, custom fields, response time, assignment) | crm.settings | ✅ | ❌ | ❌ | ❌ | ❌ | CRM-9 |
| Leads & contacts — erase a person's data (DSAR) | crm.erase | ✅ | ❌ | ❌ | ❌ | ❌ | CRM-3 |

The count goes from 32 to 36 capabilities.

**Invariants,** unit-tested over every role in `ROLE_CAPS` and mirrored in pgTAP over the SQL helpers:
- `crm.contacts ⇒ leads.manage ∧ leads.pii`
- `crm.tasks ⇒ crm.contacts`
- `crm.erase ⇒ crm.contacts ∧ leads.pii`
- `export.csv ⇒ leads.pii`

With these, each endpoint can check a single capability safely: anyone holding a contact can always see the lead PII that contact was built from.

**Why Sales gets budget and timeline (O1).** The owner granted Sales "leads, pipeline, notes" and ruled out only *bulk* contact details. Qualifying a lead needs the budget, the mockup shows budget and deadline to sales users on the lead detail, and the notes they were granted routinely quote both. The budget stays envelope-encrypted, is revealed one lead at a time behind a fail-closed audit and a rate limit, and never appears in lists, boards or exports for Sales.

If the owner says no:
- split out `leads.contact` (e-mail/phone reveal; Admin, Developer, Sales), with notes following it;
- encrypt the plaintext legacy `timeline_band` (Worker backfill) so RLS-readable plaintext can't leak;
- show budget-derived score signals only to `leads.pii` holders. That filtering is already built in (§6.3).

**Why Developer gets no `crm.*` (O2).** Developer is the technical role. The mockup gives developer no CRM. The new tables add relationship data (notes, tasks, ownership) that a technical role doesn't need, and "when in doubt, default-deny". Developer keeps its existing lead rights unchanged; nobody asked to change them. Whether Developer should keep leads now that Sales exists is an open question.

**Sales must NOT get** (each pinned by a test, §13):
- content: `services.write`, `blog.write`, `portfolio.write`, `pages.write`, `nav.edit`, `categories.manage`, `content.publish`, `content.archiveDelete`, `seo.*`, `redirects.manage`, `media.*`, `ai.*`;
- settings: `settings.general`, `settings.integrations`, `maintenance.manage`, `theme.edit`, `crm.settings`, `users.manage`;
- exports and backups: `export.csv`, `export.backup`;
- `applications.*`, `logs.*`, `audit.view`, `siteHealth.view`;
- `analytics.read`, `analytics.search`;
- `crm.erase`.

Beyond the caps:
- No direct INSERT or DELETE on `leads`; UPDATE only through the column grant.
- No `profiles` rows except its own, plus the `crm_people()` directory (id, name, role, active).
- No bulk PII: no export; lists, boards and lookups carry none; reveals are capped per user.

### 2.2 Mockup screens and actions mapped to capabilities

| Mockup | Capability |
|---|---|
| /leads list, chips, filters, KPI cards, star, mark read, bulk assign / stage / spam | leads.manage |
| Add lead manually | leads.manage + leads.pii |
| Export CSV | export.csv (Sales: button not rendered) |
| Bulk delete / Delete lead | replaced by Erase (crm.erase, per lead) and Mark as spam (leads.manage) |
| /leads/board, drag or Move to… | leads.manage |
| /leads/:id status, assignee, value, tags, star, timeline | leads.manage |
| Contact details, budget, deadline, notes thread | leads.pii |
| Email / Call / WhatsApp quick links (after reveal), Log contact | leads.pii |
| /contacts People: list, filters, star, bulk tag / owner / stage, Add contact, contact detail, contact notes, contact reveal, New lead (+leads.manage/leads.pii) | crm.contacts |
| Companies tab (CRM-11), Merge duplicates (CRM-12) | crm.contacts |
| Delete contact, Delete a person's data | crm.erase |
| /tasks, task drawer, .ics, quick task | crm.tasks |
| /crm/settings: pipeline stages, scoring, custom fields, response time / assignment | crm.settings |
| Retention value | settings.general (single source `site_settings.retention`) |
| Delete a person's data button | crm.erase |
| Inbox, Campaigns, Automations, Templates, CRM reports, Export & audiences, Import CSV, consent toggles, Unsubscribe, Files, Segments | not built (LATER, §12) |

## 3. SQL authorization layer (CRM-1, extended by CRM-10)

### 3.1 Live check (generalises `app.is_live_admin()`, 0029)

```sql
create or replace function app.live_role() returns text
  language sql stable security definer set search_path = '' as $$
  with c as (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as j)
  select p.role::text
    from c join public.profiles p
      on p.id = case when (c.j ->> 'sub') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (c.j ->> 'sub')::uuid end
   where p.is_active and (p.locked_until is null or p.locked_until <= now())
     and p.tenant_id = app.effective_tenant_id()
     and p.role::text = (c.j #>> '{app_metadata,role}')   -- divergence denies (§2 amendment)
$$;
revoke all on function app.live_role() from public, anon, authenticated, service_role;
grant execute on function app.live_role() to authenticated;
```

- It reads only the caller's own profile row, which `profiles_self_select` allows anyway, so it does not depend on BYPASSRLS.
- Used as `(select app.live_role())`, it is an InitPlan: one primary-key lookup per statement.

### 3.2 One helper per capability

Each helper is `language sql immutable` and inlined by the planner. Adding a future role is a one-function change per capability.

```sql
create or replace function app.role_works_leads(r text)  returns boolean language sql immutable as $$ select coalesce(r in ('admin','developer'), false) $$; -- leads.manage
create or replace function app.role_lead_pii(r text)     returns boolean language sql immutable as $$ select coalesce(r in ('admin','developer'), false) $$; -- leads.pii
create or replace function app.role_crm_contacts(r text) returns boolean language sql immutable as $$ select coalesce(r in ('admin'), false) $$;             -- crm.contacts
create or replace function app.role_crm_tasks(r text)    returns boolean language sql immutable as $$ select coalesce(r in ('admin'), false) $$;             -- crm.tasks
create or replace function app.role_crm_settings(r text) returns boolean language sql immutable as $$ select coalesce(r in ('admin'), false) $$;             -- crm.settings
create or replace function app.role_crm_erase(r text)    returns boolean language sql immutable as $$ select coalesce(r in ('admin'), false) $$;             -- crm.erase
```

- Each is revoked from public and granted to `authenticated` and `service_role`.
- The 0011 default privileges already keep new `app.*` routines away from PUBLIC; the explicit revoke restates it.
- `tests/authz/sqlHelpers.spec.ts` parses the last definition of each `app.role_*` across all migrations and compares its role list with the holders of the mapped capability in `ROLE_CAPS`. This turns the "SQL mirrors the matrix" claim into a CI fact.

### 3.3 `app.is_staff()` and `app.is_member()`

- `app.is_staff()` is **unchanged**. It stays the CMS-staff check (admin, content_creator, seo, developer). It gates drafts, media, redirects, themes, site_settings, site_integrations, rollups and content_versions, and Sales must read none of those.
- CRM-10 adds `app.is_member()` (any of the five roles), granted to `authenticated`. It is used by exactly one policy: `audit_insert` becomes `tenant_id = app.effective_tenant_id() and app.is_member() and actor_id = auth.uid()`. Sales can then write its own audit rows, and no session can write audit rows in a colleague's name.
- `system_logs` is written by the service role (writeSystemLog), so it is unaffected.

### 3.4 Policy template for every CRM table

```sql
create policy t_read  on public.<t> for select to authenticated using (tenant_id = app.effective_tenant_id() and app.role_<cap>(app.current_role()));
create policy t_write on public.<t> for insert|update|delete to authenticated using (...) with check (...);   -- per table
create policy t_live  on public.<t> as restrictive for all to authenticated
  using (app.role_<cap>((select app.live_role()))) with check (app.role_<cap>((select app.live_role())));
```

- RLS is ENABLE + FORCE on every table.
- Grants are stated explicitly (revoke everything from anon, then grant `authenticated` exactly what it needs).
- References between CRM rows are **composite** foreign keys `(tenant_id, x_id) → target(tenant_id, id)`. A row can't point into another tenant even through a direct PostgREST write to a granted column; this is stronger than the RPC existence checks in `save_portfolio`.
- `ON DELETE SET NULL (col)` with a column list is available on PG 15 (`supabase/config.toml` major_version 15).
- Tables that get the live RESTRICTIVE policy: leads, lead_notes, lead_events, crm_contacts, crm_contact_channels, crm_contact_notes, crm_contact_events, crm_tasks, crm_companies, crm_merge_dismissals.
- Not lead_stages or crm_settings: they hold configuration, not PII.

## 4. Leads v2 (CRM-1 schema; CRM-2/3 API)

### 4.1 Pipeline: a table, not an enum

Stage labels, tones and order are tenant-editable (mockup CRM settings: 2–10 stages, reorderable). With an enum, every edit would be a forward-only migration plus a CHECK rewrite, and labels would be code.

`lead_stages`:
- `id`, `tenant_id`, `key` (`^[a-z][a-z0-9_]{0,31}$`, unique per tenant, immutable)
- `label` (1–40), `label_ar` (nullable; for the later Arabic admin, per the §8 scalar→_ar rule)
- `tone` ∈ {klein, sky, ok, warn, err, gray}: a fixed palette of AA-checked badge tones from design.txt. Free hex is refused because it would need inline style.
- `kind` ∈ {open, won, lost}
- `is_initial` (exactly one per tenant, through a partial unique index)
- `sort_order`, `version`, `updated_at`, `updated_by`
- `unique (tenant_id, id)` so it can be a foreign-key target

A DEFERRABLE constraint trigger checks the whole set at commit: 2–10 stages, exactly one initial stage (kind open), at least one won and at least one lost. A stage can't be deleted while leads use it (FK `RESTRICT`, mapped to 409 "Move its N leads first").

Seed per tenant (the mockup's set):
- `new` "New", klein, open, initial
- `contacted` "Contacted", sky, open
- `proposal` "Proposal sent", warn, open
- `won` "Won", ok, won
- `lost` "Lost", gray, lost

**Spam is not a stage.** It stays a system flag, `leads.is_spam`, because retention depends on it (D2). Spam leads keep their stage, are hidden from the board and from KPIs, and appear under a "Spam" chip.

**Backfill map**

| status | → stage | is_spam | Timeline marker |
|---|---|---|---|
| new | new | false | `created` |
| in_progress | contacted | false | `legacy_backfill {from:'in_progress'}` |
| done | **lost** (O3; alternative: won) | false | `legacy_backfill {from:'done'}`; the list filter "Was Done" finds them for re-triage |
| spam | new | true | retention capped at now() + spam_days |

Every existing lead also gets a `created` event at its `created_at`, so no timeline starts empty.

### 4.2 New columns on `leads`

| Column | Type / CHECK | In leads_safe | Staff UPDATE grant | Written by |
|---|---|:-:|:-:|---|
| stage_id | uuid not null; FK (tenant_id, stage_id) → lead_stages | ✓ | ✓ | ingest (initial stage), staff |
| is_spam / spam_marked_at | bool default false / timestamptz | ✓ | ✓ / – | staff / trigger |
| assigned_to | uuid; FK (tenant_id, assigned_to) → profiles(tenant_id, id) ON DELETE SET NULL (assigned_to); trigger: must be an active lead worker in the tenant | ✓ | ✓ | staff, assignment rule |
| value_sar | int 0–10,000,000 | ✓ | ✓ | staff |
| is_starred | bool | ✓ | ✓ (not versioned) | staff |
| read_at / read_by | timestamptz / uuid (per lead = "someone on the team has looked") | ✓ | ✓ | detail GET, bulk |
| tags | text[] ≤10 × 1–32 chars (`app.tags_ok()`), GIN index | ✓ | ✓ | staff |
| score / score_signals | smallint 0–100 / text[] ⊆ closed key set | score ✓ / signals ✗ (derived from budget) | – | ingest, cron, recompute (definer) |
| first_response_at, won_at | timestamptz | ✓ | – | trigger |
| last_contact_at / last_contact_channel | timestamptz / call, email, whatsapp, meeting, other | ✓ | ✓ ("Log contact") | staff |
| email_hmac / phone_hmac | `^[0-9a-f]{64}$`; index (tenant_id, …) | ✗ | – | ingest, cron |
| crm_indexed_at | timestamptz | ✗ | – | cron |
| source | web_form, manual, import\*, style_finder\* (default web_form; \*reserved) | ✓ | – | ingest; server-set, never client-chosen |
| channel | organic, social, paid, referral, direct, email, phone, walk_in, whatsapp, event, unknown | ✓ | – | ingest |
| landing_path, referrer_host, utm_source/medium/campaign, device_class, country | bounded CHECKs (path `^/[^?#\s]{0,199}$`, slugs ≤64, ISO-2) | ✓ | – | ingest, from CRM-13 only |
| created_by / updated_by | uuid (`tg_set_actor`) | created_by ✓ | – | trigger |
| version | int default 1 | ✓ | – | `app.tg_lead_version` |
| search_text | generated stored `app.lead_search_text(name, company, message)` (normalize_ar + lower + left(message, 1000)); GIN trgm index | ✗ | – | generated |
| contact_id (CRM-5) | uuid; FK (tenant_id, contact_id) → crm_contacts ON DELETE SET NULL (contact_id) | ✓ | ✓ | ingest, staff |

- `email_enc` becomes nullable, with CHECK `email_enc is not null or phone_enc is not null`. Manual phone-only leads need this; the public form still requires an e-mail.
- `unique (tenant_id, id)` is added on leads and on profiles so they can be foreign-key targets.
- `ip_inet` stays unwritten and is dropped in CRM-14. `consent_marketing` is shown as "Agreed to be contacted about this inquiry". It is **not** marketing consent; a rename is noted for the contract slice.

### 4.3 Triggers on `leads`

1. **`app.tg_lead_legacy_sync`** (BEFORE INSERT/UPDATE, expand window only; removed in CRM-14).
   - If old code wrote `status`, map it to (stage_id, is_spam).
   - Otherwise derive `status`: spam → 'spam'; initial stage → 'new'; any other open stage → 'in_progress'; won or lost → 'done'.
   - The current LeadsPanel, the API, the export and the dashboard counts therefore keep working between "migration applied" and "code deployed". The deploy guard applies migrations first.
2. **`app.tg_lead_spam_retention`** (BEFORE UPDATE OF is_spam; SECURITY DEFINER because it reads `site_settings.retention`). On false→true: `spam_marked_at = now()`, and `retention_delete_after = least(coalesce(old.retention_delete_after, old.created_at + leads_months), now() + spam_days)`. Clearing spam never gives the time back (0029 pattern).
3. **`app.tg_lead_version`** bumps `version` only when a versioned field changes: stage_id, is_spam, assigned_to, value_sar, tags, contact_id. Opening a lead (read_at), starring it, logging a contact or recomputing scores never causes a spurious 409.
4. **`app.tg_set_actor`**.
5. **Pipeline stamps:**
   - `first_response_at` is set once, when the stage leaves the initial stage or `last_contact_at` is first set. Manual leads get it equal to `created_at`.
   - `won_at` is set when the stage kind becomes won and cleared when it leaves won.
6. **`app.tg_lead_events`** (AFTER UPDATE, SECURITY DEFINER) writes lead_events rows for stage_changed {from, to}, assigned/unassigned, value_set, spam_marked/spam_cleared, contact_logged {channel} and contact_linked. Every path is covered, including direct PostgREST writes.
7. **`app.tg_lead_legacy_notes`** (AFTER UPDATE OF internal_notes; expand window only) mirrors a legacy write into `lead_notes`.
8. **`app.tg_lead_assignee_check`** (SECURITY DEFINER): a non-null `assigned_to` must be an active profile in the same tenant whose role satisfies `app.role_works_leads`, else 23514 (mapped to 422).

### 4.4 Grants and policies on `leads`

```sql
drop policy leads_admin_dev_all on public.leads;
create policy leads_read   on public.leads for select to authenticated using (tenant_id = app.effective_tenant_id() and app.role_works_leads(app.current_role()));
create policy leads_update on public.leads for update to authenticated using (same) with check (same);
create policy leads_live   on public.leads as restrictive for all to authenticated
  using (app.role_works_leads((select app.live_role()))) with check (app.role_works_leads((select app.live_role())));
revoke update on public.leads from authenticated;
grant update (stage_id, is_spam, assigned_to, value_sar, is_starred, read_at, read_by, tags,
              last_contact_at, last_contact_channel, status, internal_notes) on public.leads to authenticated;
-- status and internal_notes: expand window only, revoked in CRM-14. contact_id is added in CRM-5.
-- Still no INSERT and no DELETE for any API role (0011 invariant kept).
```

### 4.5 `leads_safe`

- Re-created with `create or replace view … with (security_invoker = true)`. New safe columns are **appended** (stage_id … created_by); `create or replace` can only append (0015).
- Still not in the view: budget_enc, timeline_band, timeline_text_enc, internal_notes, ip_inet, email_enc, phone_enc, email_hmac, phone_hmac, score_signals, search_text.
- A postcondition DO block checks: security_invoker is set; none of the columns above is present; anon has no privilege; `authenticated` has neither INSERT nor DELETE on leads, and no UPDATE on `email_enc` or `retention_delete_after` (`has_column_privilege`); every lead has a stage; every tenant has exactly one initial stage.

### 4.6 `lead_notes` and `lead_events`

**lead_notes** replaces `internal_notes`.
- Columns: id; tenant_id; lead_id with FK (tenant_id, lead_id) → leads ON DELETE CASCADE, so notes are purged and erased with the lead; author_id (default auth.uid(); null for the legacy import); body (1–5000); source ∈ {staff, legacy}; created_at.
- RLS: read and insert need `role_lead_pii`. It inherits the old column's PII gate, and the owner granted notes to Sales through leads.pii. Insert also requires `with check (author_id = auth.uid())`.
- Delete: a permissive delete policy plus `role_crm_erase` (Admin, audited). Notes are append-only; corrections are made with a new note.
- Grants: select, insert, delete.
- An AFTER INSERT trigger writes a `note_added {note_id}` event.
- Backfill: one row per non-empty `internal_notes` (source legacy, `created_at = updated_at`).

**lead_events** is the product timeline. It is deliberately not `audit_log`, which is the security ledger.
- Columns: id (identity), tenant_id, lead_id (FK cascade), at, actor_id (null = system), kind (CHECK list: created, stage_changed, assigned, unassigned, value_set, spam_marked, spam_cleared, contact_logged, note_added, contact_linked, task_created, task_done, merged, legacy_backfill), detail (jsonb object < 2 KB; **metadata only**, never note bodies or PII).
- Read needs `role_works_leads`.
- No INSERT grant to authenticated. Inserts come only from the definer triggers and the service-role ingest. An INSERT policy with no TO clause (tenant + role helper on the caller's JWT, as `content_versions_insert_staff` in 0009 does) lets the triggers write under FORCE RLS.
- Index: (tenant_id, lead_id, at desc).

### 4.7 `crm_settings` (singleton per tenant; CRM-1 seeds it, CRM-9 edits it)

- `tenant_id` PK
- `scoring` jsonb: signal key → points 0–50, closed key set, CHECK object
- `custom_fields` jsonb: an array of at most 12 {key, label, type ∈ text, number, date}
- `sla_hours` smallint 1–168, default 24
- `assignment_rule` ∈ {manual, round_robin, fixed}, default manual
- `assignment_pool` uuid[] (≤20, validated as active lead workers), `assignment_fixed_to` uuid, `rr_cursor` int
- `timezone`: allowlist CHECK, default 'Asia/Riyadh'
- `version`, `updated_at`, `updated_by`

RLS: select by lead workers or `crm.settings` holders (configuration, no PII); update by `crm.settings` holders. Messaging settings are a different table later (§12) with its own capability: an SEO-style split cutting through one row would fail the §2 Phase-3 amendment.

## 5. Contacts, companies, tasks, merge

### 5.1 Contacts (CRM-5)

**crm_contacts**
- Columns: id; tenant_id; display_name (1–120); `name_key` (generated `app.crm_name_key()`: lower-cased, `app.normalize_ar`, leading al-/el-/ال tokens dropped; GIN trgm); title ≤120; company_name ≤120; stage ∈ {lead, client, past, partner} default lead; source ∈ {web_form, manual, referral, instagram, event, google, linkedin, direct, whatsapp, import\*}; owner_id with FK (tenant_id, owner_id) → profiles ON DELETE SET NULL (owner_id), trigger-checked as an active crm.contacts holder; locale ∈ {en, ar}; city ≤80; country ISO-2; tags (same rule as leads); custom jsonb (object, < 8 KB, validated by the API against crm_settings.custom_fields); is_starred; last_activity_at; merged_into / merged_at (CRM-12); `search_text` (generated); version and actor columns; unique (tenant_id, id).
- Indexes: (tenant_id, stage, last_activity_at desc) where merged_into is null; GIN on tags; trgm on search_text; (tenant_id, owner_id).
- **Not stored:** value and score. They are derived in the list RPC: value = sum of `value_sar` over the linked won leads; score = the highest linked lead score. Nothing to drift.

**crm_contact_channels** (a person can have several e-mails or phones; this keeps dedupe stable after merges)
- Columns: id; tenant_id; contact_id (FK cascade); kind ∈ {email, phone}; `value_enc` (AES-GCM base64 under LEAD_PII_ENC_KEY: the same key and purpose as leads, so ingest copies the lead's ciphertext without decrypting); `value_hmac` (64 hex); `domain_hmac` and `is_freemail` (e-mail only); is_primary; source ∈ {lead, manual, merge, import\*}; created_at / created_by.
- Partial unique index (tenant_id, value_hmac) where kind = 'email': one e-mail, one person.
- Phones are not unique (shared office numbers); they are indexed only.
- Partial unique index (contact_id, kind) where is_primary.

**crm_contact_notes**: like lead_notes, keyed to the contact.

**crm_contact_events**: like lead_events. Kinds: created, stage_changed, owner_changed, lead_linked, channel_added, channel_removed, details_changed, merged.

**Triggers:**
- `last_activity_at` advances on: a lead linked, a contact or lead note, a lead event, a task done, a staff stage change.
- A linked lead reaching a won stage moves the contact from lead or past to client.
- A lead assignee fills an empty contact owner.

### 5.2 Linking leads to contacts

- **On arrival:** `crm_ingest_lead` v2 (service_role only) runs in one transaction. It looks up the e-mail channel by blind index. If none exists, it inserts the contact and channel with `on conflict … do nothing` and re-selects (race-safe when two leads from the same new address arrive together). It adds a new phone channel, sets `lead.contact_id`, sets the `returning` signal and writes the events. Phone matches are never auto-linked; they go to the merge finder.
- **Backfill:** the Worker's daily cron, first for missing blind indexes (CRM-1), then `crm_link_lead` (CRM-5) for leads with `contact_id` null. The contact is created from the lead's name, company and locale, with the channel ciphertext copied over.

### 5.3 Companies (CRM-11)

- **crm_companies:** name (1–120), name_key, sector_id (→ the public `sectors` taxonomy, tenant-checked), size ∈ {1-10, 11-50, 51-200, 200+}, website (https, ≤2048), city, stage, owner_id, notes ≤2000, optional client_id (→ the public `clients` logo/disclosure row; a link only — `clients.visible` stays the disclosure permission owned by portfolio.write), version, actor columns.
- `crm_contacts.company_id` gets a composite FK ON DELETE SET NULL (company_id). `company_name` stays as free text for leads.
- "Create company from this name" is offered, because the mockup has no way to create a company.

### 5.4 Tasks (CRM-8)

**crm_tasks**
- Columns: id; tenant_id; title (1–200); type ∈ {call, email, whatsapp, meeting, todo}; contact_id and lead_id (both optional composite FKs, CASCADE); owner_id (composite FK, SET NULL, trigger-checked); `due_at timestamptz not null`; done_at; note ≤2000; version and actor columns.
- Indexes: (tenant_id, owner_id, done_at, due_at), (tenant_id, contact_id).
- RLS: `role_crm_tasks` for all operations, plus the live check. Grants: select, insert, update, delete.
- Triggers write task_created / task_done into lead_events and contact events.

### 5.5 Merge (CRM-12)

- `crm_merge_dismissals` (tenant_id, contact_a < contact_b, created_by, created_at; PK on the three ids; FKs cascade).
- The merge is a SECURITY INVOKER RPC that turns the dropped record into a tombstone, so it needs no DELETE grant (§6.4).

## 6. Crypto, normalisation, scoring

### 6.1 Blind indexes (CRM-1)

- `CRM_INDEX_LABEL = 'crm-index/v1'` in src/lib/applications/keys.ts, next to the applicant and rate-limit labels. No new secret.
- `hmacHex` moves from publicRateLimit.ts to src/lib/crypto/hmac.ts and is re-exported from the old place.
- `blindIndex(kind, tenantId, normalized) = hmacHex(labelledKeyMaterial(LEAD_PII_ENC_KEY, CRM_INDEX_LABEL), kind + '\0' + tenantId + '\0' + normalized)`.
  - Salted by tenant: no cross-tenant correlation.
  - Separated by kind (e-mail, phone, domain).
  - A versioned label allows rotation: compute v2 from the ciphertext in a cron job, then switch.
- With the key secret, a database leak can't be brute-forced, even for low-entropy phone numbers.

### 6.2 Normalisation (src/lib/crm/normalize.ts, pure)

- **E-mail:** trim, NFKC, lower-case, IDN domain to punycode. No gmail dot or plus folding; aggressive folding causes false merges.
- **Phone → E.164:**
  - Arabic-Indic and Persian digits become ASCII.
  - Separators are stripped.
  - `00` becomes `+`.
  - A leading 0 or a bare 9-digit 5xxxxxxxx uses the tenant default country from `site_profile.address_country` ('SA' → +966).
  - The result must match `^\+[1-9][0-9]{7,14}$` (the 0019 rule).
  - If it can't be normalised: no phone_hmac, and the phone is still stored encrypted as given.
- **Freemail:** a code-owned `FREEMAIL_DOMAINS` set (gmail, googlemail, hotmail, outlook, live, msn, yahoo, icloud, me, mac, aol, proton, gmx, yandex, mail, zoho).

### 6.3 Scoring (CRM-1 computes at ingest; CRM-9 edits the points)

- **Closed signal keys:**
  - named_service: asked about a specific service
  - budget_given: budget not not_sure / undisclosed
  - budget_200k_plus: gt_200k, or legacy gt_150k
  - company_email: not freemail
  - company_named
  - timeline_given
  - returning: the e-mail blind index was seen before
  - service_page: form sent from /services/…; live from CRM-13
  - reserved and hidden until their phase: replied, opened_campaign
- Defaults: service_page 10, named_service 10, budget_given 15, budget_200k_plus 25, company_email 10, returning 10, company_named 5, timeline_given 5.
- Score = `least(100, Σ points)`, from the immutable `app.lead_score(signals, scoring)`.
- Signals are computed in the Worker from plaintext **before** encryption and stored as keys only.
- Old leads are scored by the cron backfill: it decrypts server-side and no human sees the values.
- Changing points recomputes every lead in one UPDATE through a SECURITY DEFINER `app.recompute_lead_scores()`. It checks the live `role_crm_settings` internally, because `score` is outside the staff column grant.
- Budget- and timeline-derived reasons are returned only to `leads.pii` holders; the number is returned to every lead worker. That keeps O1's "no" path ready.

### 6.4 What stays encrypted, hashed, plaintext or never stored

- **Encrypted (AES-256-GCM, LEAD_PII_ENC_KEY):** lead email_enc, phone_enc, budget_enc, timeline_text_enc; contact channel value_enc.
- **Keyed hashes:** e-mail, phone and domain blind indexes.
- **Plaintext under RLS and the live check:** names, company, message, notes, tags, title, city, custom fields, task titles. Notes are not in the §3 envelope list, as with internal_notes today.
- **Never stored:** IP addresses, full user-agent, full referrer URL, query strings, anything linking a lead to an analytics session.

## 7. Ingest and attribution

### 7.1 Public form (CRM-1)

`createLead`:
1. Validates exactly as today.
2. Reads the tenant's default country.
3. Normalises, encrypts and computes blind indexes and signals.
4. Calls `rpc('crm_ingest_lead', {p_tenant, p_lead})` with the service role. The RPC is an allow-listed jsonb, SECURITY INVOKER and executable by service_role only, like `public_write_hit`. It inserts the lead (initial stage, `source` web_form set on the server, signals, score, assignment from CRM-9) and its `created` event in one transaction.
5. **If the RPC fails, the code falls back to today's plain insert.** The sync trigger still assigns a stage; a `system_logs` warning carries no PII; the cron links the lead later. A lead is never lost (§3: the contact form "fails open").

notify-lead is unchanged: its trigger fires after insert on any path.

### 7.2 Manual add (CRM-3)

`POST /api/admin/leads` needs leads.manage and leads.pii.
- **Fields** (`LeadManualCreateSchema`): name; company; e-mail and/or phone; service (published slugs); budget band; timeline ≤120; message; locale; channel ∈ {phone, walk_in, whatsapp, email, event, referral, other}.
- **Path:** the same service-role RPC, with source manual, created_by = auth.userId and `first_response_at = created_at`.
- **Duplicates:** a matching e-mail links automatically to the existing contact, and the UI says so. A phone-only match returns 409 `possible-duplicate {contactId, name}` unless `linkContactId` or `createNew` is sent.
- **Audit:** `lead.create {source, channel}`.

### 7.3 Attribution (columns in CRM-1; capture only in CRM-13, after the privacy notice is updated)

- **Captured with every submission and disclosed (no consent needed):** `landing_path`. The server derives it from the same-origin Referer of the POST, query and fragment stripped. The client never supplies it. It is the form's own context, like `kind` and the interest slug.
- **Captured only with analytics consent:** referrer_host (cross-site host only), utm_source / medium / campaign (bounded slugs), device_class (from Client Hints or the UA at submit time), country (`request.cf.country`; verify the accessor in adapter 14).
  - The client stores first-touch values in sessionStorage only when `hasConsent('analytics')` is true. This is a sub-1 KB addition to the existing consent-gated analytics client.
  - The server re-checks the `__Host-consent` cookie through the single `hasConsent` gate and drops the fields otherwise. This is the gate of record, mirroring the RUM beacon.
- **Channel classification on the server:** paid UTM medium → paid; social hosts → social; search engines → organic; another referrer → referral; none → direct; no consent → unknown.
- **PDPL:** the privacy notice (src/lib/legal/content.ts, EN and AR, version bump) gains a paragraph covering what is recorded with an inquiry, the consent dependency and the retention. Legal must sign off (O4); this slice ships nothing until then.
- **Never captured:** IP, city, full URLs, session ids.

## 8. Retention and erasure

### 8.1 Horizons

One source of truth, `site_settings.retention.leads_months` (Zod max 24 until legal signs off longer). It is a single horizon, never longer than the leads horizon.

| Data | Horizon | Mechanism |
|---|---|---|
| Leads | created_at + leads_months, or retention_delete_after | `app.purge_leads` (existing). Notes, events and tasks on the lead go by cascade. |
| Spam leads | min(original, marked + spam_days) | CRM-1 trigger, then purge_leads |
| Contacts | last_activity_at + leads_months. Shown under "Expiring soon" for the last 30 days, as a list chip and a dashboard count. | `app.purge_crm()`, called from `app.run_retention()` (CRM-5). Channels, notes and events go by cascade. |
| Orphan auto-contacts | Next run, once no lead, note or task remains and staff never edited the record (version = 1, source web_form) | purge_crm |
| Tasks | done: done_at + horizon. Open: with their contact or lead. Unlinked: created_at + horizon. | purge_crm (CRM-8) |
| Merge tombstones | Next run | purge_crm (CRM-12) |
| Audit rows | Never deleted (ids and field names only) | none |

- pgTAP calls `app.run_retention()` and asserts that rows are actually gone. The harness's `postgres` role is the one pg_cron uses; 0009 warned that FORCE RLS plus a definer is fragile.
- Staging check (O8): confirm the cron role bypasses RLS on hosted Supabase. This applies to today's `purge_leads` too.
- The mockup's "Older records are flagged for review, not deleted silently" becomes "Records with no activity for N months are deleted. They show under Expiring soon for 30 days first." Data is never kept indefinitely (§3 "retention purge. PDPL").

### 8.2 Erasure (CRM-3 for a lead, CRM-5 for a person; Admin, `crm.erase`)

**Endpoint sequence:**
1. `assertCap`
2. `liveRecheck`
3. `claimPrivilegedOp('crm-erase', 20 per hour per user, 50 per hour per tenant)`
4. `writeAudit 'crm.erase.attempt'` with {target, counts, reason}. **Fail-closed: no audit row, no erase.**
5. The service-role RPC `crm_erase_lead(p_tenant, p_lead)` or `crm_erase_person(p_tenant, p_contact, p_extra_leads)`
6. `writeAudit 'crm.erase.outcome'` with the counts

**What `crm_erase_person` deletes,** in one transaction:
- every lead linked by contact_id or sharing one of the person's **e-mail** blind indexes;
- the phone-only matches the Admin ticked in the preview. Phones are shared, so they are never deleted silently: `GET …/erase-preview` lists those leads with safe columns only.
- the person's tasks;
- the contact, and by cascade its channels, notes, events and dismissals.

No lead PII is left orphaned.

- The service role is used because no API role may DELETE from leads (the 0011 invariant), and its BYPASSRLS doesn't depend on `postgres`'s attributes.
- Backups (PITR 28 days, the off-platform dump) keep erased rows until they roll over. The privacy notice must say so (O4).
- LATER hook: if the person also asks not to be contacted, write a `crm_suppressions` tombstone (HMAC only).

## 9. API surface

Every route goes through `defineAdminRoute` (assertCap, Zod, no-store, error mapping, queued audit). The Zod schemas live in `packages/schemas/crm.ts`.

RPC errors map as follows: 40001 → 409 conflict; P0002 → 404; 42501 → 403; 23505 → 409 duplicate {field}; 23514 / 22023 → 422; 23503 → 422 "linked record missing".

**Query endpoints take a POST body (D10).** Search `q` is ≤64 characters with control characters stripped (`cleanQuery`):
- a complete e-mail matches through `email_hmac` (exact);
- a complete phone matches through `phone_hmac` (exact);
- anything else uses trigram `ilike` on `search_text`, escaped.

**Leads** (CRM-2 read side, CRM-3 write side)

| Route | Capability | Extra | Audit |
|---|---|---|---|
| POST /api/admin/leads/query {filters, sort, limit 15–100, offset} | leads.manage | RPC `leads_list` (INVOKER, safe projection, total via count(*) over()) | none |
| POST /api/admin/leads/summary {filters} | leads.manage | RPC `lead_summary` | none |
| POST /api/admin/leads/board {filters, perStage ≤50} | leads.manage | RPC `leads_board`: per stage count, won-value sum and top N cards | none |
| POST /api/admin/leads/[id]/neighbours {filters} | leads.manage | RPC `lead_neighbours` | none |
| GET /api/admin/leads/[id] | leads.manage | Detail, plus notes if leads.pii, plus the first events page, plus the linked contact if crm.contacts. Sets read_at if null. | lead.view {notes: n} |
| GET /api/admin/leads/[id]/events?before= | leads.manage | | none |
| POST /api/admin/leads/[id]/reveal | leads.pii | liveRecheck; `claimPrivilegedOp('pii-reveal', 60/h per user, 300/h per tenant)`, shared with contacts | lead.view_pii {fields}, written directly and **fail-closed before decrypting** |
| POST /api/admin/leads/[id]/notes {body} | leads.pii | | lead.note.create |
| DELETE /api/admin/leads/[id]/notes/[noteId] | crm.erase | liveRecheck | lead.note.delete, fail-closed |
| PATCH /api/admin/leads/[id] | leads.manage | `version` required for stageId, assignedTo, valueSar, tags; optional for isStarred, read, logContact {channel} | lead.update {fields, stage} |
| POST /api/admin/leads/bulk {items ≤100 [{id, version}], action ∈ assign, stage, read, star, spam, tagAdd, tagRemove} | leads.manage | RPC `leads_bulk_update` returns the applied rows; the rest come back as conflicts | one `lead.update` per lead (new `writeAuditMany`: one multi-row insert, chained per row) plus `lead.bulk {action, count}` |
| POST /api/admin/leads | leads.manage + leads.pii | Service-role ingest | lead.create |
| POST /api/admin/leads/[id]/erase {reason} | crm.erase | §8.2 | attempt + outcome |
| GET /api/admin/leads/export | export.csv | Unchanged lockdown. Now honours the list filters and adds stage, assignee, value_sar, tags, score, source and channel. **Drops note bodies** (notes_count instead): bulk free-text is the riskiest PII. | attempt + outcome |
| GET /api/admin/crm/people | any of leads.manage, crm.contacts, crm.tasks, crm.settings | RPC `crm_people()` (DEFINER): id, display_name, role, is_active in the caller's tenant; empty unless the caller live-holds a CRM capability | none |
| GET /api/admin/crm/stages | leads.manage or crm.settings | | none |

Legacy `GET /api/admin/leads?…` and `GET …/[id]?pii=1` are fixed to be fail-closed and rate-limited in CRM-2 and removed in CRM-14. PATCH `internalNotes` returns 422 from CRM-2. The dashboard counts in `dashboard.ts` and `index.astro` move to "initial stage and not spam".

**Contacts** (CRM-6). Every route needs crm.contacts unless noted.

| Route | Notes | Audit |
|---|---|---|
| POST /api/admin/crm/contacts/query, /summary | | none |
| POST /api/admin/crm/contacts/lookup {q} | ≤8 results {id, name, company, stage}. Never e-mail or phone. | none |
| POST /api/admin/crm/contacts | RPC `crm_create_contact` (INVOKER, contact and channels together). Duplicate e-mail → 409 {contactId}. | crm.contact.create |
| GET /api/admin/crm/contacts/[id] | Channel *presence* ({kind, isPrimary}) only, plus linked leads (safe), open tasks, the first timeline page and the custom field definitions | crm.contact.view |
| PATCH /api/admin/crm/contacts/[id] | version; channel edits require liveRecheck | crm.contact.update {fields} |
| POST /api/admin/crm/contacts/[id]/reveal | liveRecheck; the shared `pii-reveal` limiter | crm.contact.view_pii, fail-closed |
| POST /api/admin/crm/contacts/[id]/notes | DELETE needs crm.erase | |
| GET /api/admin/crm/contacts/[id]/timeline?filter&before | RPC `crm_contact_timeline` (INVOKER, UNION over contact events, contact notes, linked lead events and lead notes, which RLS hides from non-pii holders, and tasks; limit 60, keyset) | crm.contact.view {page} |
| POST /api/admin/crm/contacts/bulk | ≤100 [{id, version}]; actions addTag, removeTag, owner, stage, star | one audit row per contact |
| POST /api/admin/crm/contacts/[id]/leads | Also needs leads.manage + leads.pii. "New lead" copies the contact's channel ciphertext. | lead.create |
| GET …/erase-preview, POST …/erase | crm.erase; §8.2 | |

**Tasks** (CRM-8). Every route needs crm.tasks.
- `GET /api/admin/crm/tasks?view=mine|all`: RPC `crm_tasks_grouped(view, tz)` returns {overdue, today, upcoming, done (last 20 within 30 days)} with counts.
  - overdue = not done and due_at < now()
  - today = the same calendar day in `crm_settings.timezone`
- `POST /api/admin/crm/tasks`: takes {dueDate, dueTime}, converted in SQL in the tenant time zone.
- `PATCH /[id]`: version; done; `snooze: 'tomorrow_10'` is computed in SQL in the tenant time zone.
- `DELETE /[id]`.
- `GET /[id]/ics`:
  - Headers: `text/calendar; charset=utf-8`; `Content-Disposition: attachment; filename="<ascii-slug ≤60>.ics"`; no-store.
  - VEVENT: UID `<task id>@<host of PUBLIC_SITE_URL>`; PRODID `-//<site_profile.brand_name.en>//Admin//EN`; DTSTAMP and DTSTART in UTC; DURATION PT30M; SUMMARY = the escaped title; DESCRIPTION = the admin deep link only. The contact's name and the note are left out (data minimisation).
  - RFC 5545 escaping and 75-octet line folding.
- All task writes are audited `crm.task.*`.

**Settings** (CRM-9)
- `GET` and `PUT /api/admin/crm/settings` (crm.settings, version): `save_crm_settings` recomputes scores when the points change.
- `PUT /api/admin/crm/stages` (crm.settings; carries `crm_settings.version`): RPC `save_lead_stages` (INVOKER) upserts, reorders and deletes unused stages; the deferred shape trigger is the backstop.
- Audits: `crm.settings.update`, `crm.stages.update`.
- The retention control writes `site_settings` through the existing settings endpoint (settings.general).

**Companies** (CRM-11): `POST /api/admin/crm/companies/query`, `POST`, `PATCH /[id]`, `DELETE /[id]`. All need crm.contacts and are audited.

**Merge** (CRM-12)
- `GET /api/admin/crm/duplicates` → RPC `crm_duplicate_pairs(limit 50)`. Pairs come from: the same phone blind index; the same non-freemail domain blind index plus `name_key` trigram similarity ≥ 0.6 or the same first token; or the same name_key plus the same company_name. Dismissed pairs and tombstones are excluded.
- `POST /api/admin/crm/contacts/merge {keepId, keepVersion, dropId, dropVersion}` → RPC `crm_merge_contacts` (SECURITY INVOKER, both rows locked in id order, version 40001, tenant-fenced). It:
  - moves channels (the moved one becomes primary if the kept record has none);
  - fills blank fields;
  - unions tags (cap 10);
  - ORs the star;
  - fills custom values;
  - takes the stage by precedence: client > lead > past > partner;
  - re-points leads, tasks, notes and events;
  - writes a `merged` event;
  - turns the dropped record into a tombstone: `merged_into`, a scrubbed name, no tags or custom values. No DELETE grant is needed.
  - inserts `audit_log 'crm.contact.merge' {keep, drop, moved}` **inside the same transaction** (`actor_id = auth.uid()`).
- `POST /api/admin/crm/duplicates/dismiss`.
- All three need crm.contacts.

**Dashboard feed** for the dashboard architect: `GET /api/admin/crm/overview` (any of leads.manage, crm.tasks; each part gated): newWaiting, slaBreached, myOverdueTasks, myTodayTasks, the pipeline per stage {count, value}, wonThisQuarter by won_at. Never budget.

**KPI definitions** (`lead_summary`). The range filter applies to created_at; spam is excluded everywhere.
- New: count in the initial stage.
- In progress: count in other open stages.
- Won: count of won-kind leads plus Σ value_sar.
- Conversion ("Won of all leads"): won ÷ all leads in range.
- Average first response: avg(first_response_at − created_at) over web_form leads in range; "Not enough data yet" when fewer than 5.
- Deltas: against the previous equal period, only when a range is set. No invented numbers.
- Chip counts ignore the other filters (mockup), plus Spam and Unread counts.
- SLA breach: web_form, initial stage, `first_response_at` null and `created_at` older than `sla_hours`.

**Scale.** All of this is fine at about 10⁴ leads: indexed, one round trip, bounded like `search_content`. CRM reports (LATER) will read `rollup_crm_*` (Pillar 4 "dashboards read rollup_*").

## 10. Sales role (CRM-10)

**SQL.** `0037_app_role_sales.sql` contains one statement, alone in its file:

```sql
alter type public.app_role add value if not exists 'sales';
```

- **Transaction caveat.** On PG ≥ 12 the statement is allowed inside a transaction, but the new value can't be *used* until the transaction commits (SQLSTATE 55P04, "unsafe use of new value"). The Supabase CLI applies each migration file in its own transaction, so no statement in this file may cast to, compare with or store 'sales' as an `app_role`.
- Everything that does goes in `0038_sales_role.sql`. If a toolchain ever batches both files into one transaction, it fails loudly, not silently; then apply them separately.
- Enum values can't be dropped. Rolling back means demoting every Sales user and leaving the value unused.

`0038_sales_role.sql`:
- `app.is_member()`.
- `audit_insert` rewritten (§3.3).
- The four helpers re-created: `role_works_leads` and `role_lead_pii` gain 'sales' (admin, developer, sales); `role_crm_contacts` and `role_crm_tasks` gain 'sales' (admin, sales). `role_crm_settings` and `role_crm_erase` are unchanged.
- No other policy changes. `is_staff()` is deliberately untouched, so Sales reads zero rows from every staff-only table.
- Postconditions: 'sales' ∈ `enum_range(null::app_role)`; `is_staff()` excludes sales; `audit_insert` uses `is_member`; every helper's role list matches §2.

**Custom Access Token Hook.** No change: it projects `p.role::text` for any enum value. `resolveAuthContext` fails closed (DENY_ANON) for an unknown role until `ROLES` includes 'sales', which is why the TypeScript ships with the migrations. The deploy guard applies migrations before the code.

**Rollout:**
1. Apply 0037, then 0038.
2. Deploy.
3. Invite Sales users or change existing users' roles. A user changed mid-session hits the divergence-denies rule (the JWT says the old role, the profile says sales) and must sign in again; the UsersPanel copy already says so.

**TypeScript:**
- `ROLES` and `RoleSchema` gain 'sales'.
- `ROLE_CAPS` gets a Sales row.
- UsersPanel imports `ROLES` (D8), shows a role label and a one-line description per role ("Sales: works leads, contacts and tasks. Sees a lead's contact details and budget one at a time (logged). No content, settings, exports or job applications."), and recommends a display name so assignees are readable.
- notify-lead's recipients are derived from the holders of `leads.manage` (D8); its field gating stays `canSeeLeadPii`.
- nav.ts: a CRM group (Leads, Contacts, Tasks; Inbox etc. later), CRM settings under Settings, and the Dashboard link caps become `['analytics.read', 'leads.manage']` so Sales has a home with lead and task widgets only. Every widget stays gated by its own capability (the dashboard.ts rule). Sales never sees analytics.
- The topbar search is hidden for roles with no searchable entity (UX only).
- Shell data Sales needs must not depend on `is_staff()`: the brand from `site_profile` is anon-readable; theme tokens need a server read that doesn't rely on the caller.

**Docs and tests:** §14 and §13. `matrix.spec` gets a 6-cell parser, 5 roles, 36 caps, the new labels and a parse of architecture §3.4. `endpoints.spec` iterates `ROLES`, so every existing row automatically asserts Sales = 403; the CRM rows' allow lists gain 'sales'.

## 11. UI contract for the UI architect

**General**
- React islands on the Admin v2 primitives: drawer and modal on native `<dialog>`; chips; segmented control; selectable table with a bulk bar; tone badges; avatar; KPI card; typeahead.
- No inline `style`, including React style props during SSR. Use classes, `data-tone`, `.bar-fill[data-width]` 5% buckets with `data-band` ∈ {ok, klein, warn} (≥75, ≥55, else), avatar `data-av` = hash(id) mod 7, and timeline `data-kind`. CSSOM writes after hydration are allowed.
- No `window.prompt` or `window.confirm` (confirm.ts). Toasts for success only; errors inline and persistent.
- Every island is added to **both** lists in .size-limit.json. No new libraries in the core (no dnd, chart or icon library) unless budget-checked.
- Person data (names, messages, notes, task titles) renders with `dir="auto"`. The admin chrome stays English.
- Page `<title>` is generic ("Lead · Admin", "Contact · Admin"); the h1 carries the name, which keeps names out of tab titles and history.
- URLs carry ids, never names or e-mails. Filter state lives in the URL **except `q`**.
- Every write sends the `version` it loaded and handles 409 with "Someone else changed this. Refreshed." plus a refetch.
- Discrete controls (stage select, star, assign, tags, done) are one PATCH each, applied at once. Forms (contact Details, company, settings) have explicit **Save**. There is no keystroke autosave, so "Changes save as you type" is not used.
- Every page computes `can()` server-side and renders the lock state "You do not have access to this / Ask an admin if you need it." The API remains the authority.

**PII rules**
- Budget, timeline, e-mail, phone and notes never appear in lists, cards, boards, the typeahead, merge pairs, the erase preview, toasts, breadcrumbs, the ⌘K palette, global search or the notifications feed.
- Contact details are masked, with **"Reveal contact details (this access is logged)"**. Revealed values live in component state only: never localStorage, never kept across navigation.
- mailto:, tel: and wa.me links render only after a reveal.
- No client-side CSV. "Export CSV" is a link to the server export carrying the current filters, rendered only for export.csv holders.

**Screens**

1. **Leads list** `/admin/leads`.
   - Head "Leads", sub "{N} inquiries. {n} new, {u} unread."
   - Actions: Inbox | Pipeline switch, Export CSV (export.csv only), Add lead manually.
   - Five KPI cards from `/summary`.
   - Toolbar: search (placeholder "Search name, company or message. Full e-mail or phone also works."); stage chips with counts, then Spam; selects for discipline, source (Web form or Manual + channel; attribution sources after CRM-13), assigned (Anyone, Me, Unassigned, a person), range (7, 30, 90 days, all time).
   - Bulk bar: Assign to…, Move to stage…, Mark read, Star, Mark as spam. **No Delete.**
   - Table, 15 per page: ☆; Lead (bold when unread, company under it); Interest (service label and discipline); Source badge (`data-tone` by channel); Stage badge; Assigned (avatar or "Nobody"); Received (ago; over the SLA it shows the text "Over response time" plus a class, never colour alone). **No Budget column.**
   - Empty state: "No leads match / Try another filter or clear the search."
2. **Board** `/admin/leads/board`.
   - Sub: "Drag a card, or use Move to…, to change its stage. Won cards add up at the top of their column."
   - Columns: non-spam stages in order, each with a count; the won column shows the SAR sum.
   - Cards: name, company, interest, value if set, age, assignee, ☆, unread dot. No budget.
   - Every card has a **Move to…** menu (WCAG 2.1.1 and 2.5.7). Pointer drag-and-drop is optional (native or pointer events). Moves are announced through aria-live ("Moved Sara to Proposal sent").
   - Each column caps at 50 cards with "Show all in list".
3. **Lead detail** `/admin/leads/[id]`.
   - Head: name; badges (stage, source, starred); sub "company · interest · received {date}"; Back, Previous and Next (within the current filter, via `/neighbours`). Erase (Admin) sits in an overflow menu, as a danger action.
   - Left column:
     - Message card ("Sent {ago} in Arabic|English").
     - Details card: company; interest (linked to the service editor only for services.write holders); language; received; "Agreed to be contacted about this inquiry: yes/no"; after CRM-13 also page, source/channel/utm, device and country.
     - Contact & budget block: masked, then Reveal, which shows e-mail, phone, budget, timeline, the Email, Call and WhatsApp links, and "Log contact" (call, e-mail, WhatsApp, meeting).
   - Right column:
     - Status card: stage select, assigned to, value in SAR (any non-initial open stage, or won), lead score bar with "N / 100" and reasons (pii holders), starred toggle, tags.
     - Notes card ("Only your team sees these"; thread, then "Write a note…" and Add note; "Write something first").
     - Timeline card (events, newest first).
     - Contact card (crm.contacts): "Contact: {name}, Open" or "Not linked".
     - Tasks card (crm.tasks): open tasks plus quick add.
   - The mockup's Suggested reply and Send email are not built (no outbound; LATER).
4. **Add lead drawer.** Name\*; Company; E-mail and/or Phone (at least one); Service (grouped by discipline, published only); Budget (`BUDGET_BANDS` labels); "When do you need it?" (≤120); Message\*; Language; How they reached us (channel). An e-mail match shows "Linked to {contact}". A phone match asks "Link to {name}" or "Create new".
5. **Contacts** `/admin/contacts`.
   - Head "Contacts", sub "{N} people · {n} clients · {n} leads · {n} past clients" (plus "· {n} companies" after CRM-11).
   - Actions: Add contact; Merge duplicates (CRM-12). Import CSV and Export are **not shown** (LATER).
   - Tabs: People | Companies (CRM-11). Segments is not shown.
   - Toolbar: search, stage chips with counts, then Tag, Source, Owner (Anyone, Me, No owner, a person), City, Sort (Last activity, Newest, Value, Name), and an "Expiring soon" chip.
   - Bulk bar: Add tag, Remove tag, Change owner…, Change stage…, Star. No Export, Delete or Add to campaign.
   - Table, 20 per page: ☆; Person (name and title); Company; Stage (Lead klein, Client ok, Past client gray, Partner sky); Tags (3 plus "+n"); Owner; Last activity; Value (SAR, right-aligned). **No Consent column.**
   - Empty state: "Nobody matches / Try another filter or clear the search."
6. **Contact detail** `/admin/contacts/[id]`.
   - Header: avatar, name and ☆, "title at Company"; Stage and Owner selects; tags.
   - Actions: Reveal contact details (logged), then Email, WhatsApp and Call; Add task; New lead; Erase (Admin).
   - Left: Timeline card with the note composer ("Only your team sees notes."), chips All | Leads | Tasks | Notes (Messages and Campaigns hidden until LATER), and "Load older".
   - Right:
     - Details (explicit Save; e-mail and phone editable only after a reveal; custom fields).
     - Leads (linked; New lead).
     - Score ("Rules live in CRM settings").
     - Data card: "Added {date} · last activity {ago} · kept until {date} unless there is new activity".
   - **No** Consent card and **no** Files card (LATER).
7. **Add contact drawer.** Name\*; Title; E-mail; Phone or WhatsApp; Company (typeahead, or free text); Stage (Lead); Owner (me); Language (English); City (no default — the mockup's hard-coded 'Jeddah' is dropped); Source (Manual); Tags. Validation: "Give them a name"; a duplicate e-mail shows "Someone with this e-mail already exists" with an Open link. **Consent toggles are not shown** (LATER).
8. **Erase dialog** (Admin).
   - Contact picker (CRM lookup).
   - Preview: "{name}: {n} leads, {n} notes, {n} tasks", plus phone-only matches as checkboxes.
   - Reason: Their request (DSAR) | Our decision.
   - A danger button "Erase everything about them", then a second confirm.
   - Copy: "Logged in the audit log." and "Answer within 30 days."
9. **Merge** (CRM-12, large modal). Each pair shows reason text, never values, with "Merge into older" (swap available) and "Not a duplicate". A preview lists what moves. Empty state: "No likely duplicates".
10. **Tasks** `/admin/tasks`.
    - Head "Tasks", sub "{n} overdue · {n} today · {n} upcoming, for you|for everyone".
    - Segmented control My tasks | Everyone (falls back to Everyone when I have none); New task.
    - Sections: Overdue (header marked), Today, Upcoming, Done (collapsed; last 20). Empty copy: "Nothing overdue. Nice." / "Nothing due today." / "Nothing coming up." / "Nothing done yet."; page empty state: "No tasks / Add one from a contact, a lead or the button above."
    - Row: checkbox; type icon; title; contact link and company; "date · relative" (overdue = class plus the word "Overdue"); note; Edit, Snooze to tomorrow 10:00, Open contact, Delete (confirm). The mockup's "Send" becomes Open contact (no inbox).
    - Drawer: What needs doing\*; Type; Due date and **time** (default 10:00 in the tenant time zone); Contact; Lead; Owner (me); Note; footer "Download .ics" (after saving) and Create or Save.
    - The calendar-connection banner is not shown (LATER).
11. **CRM settings** `/admin/crm/settings` (crm.settings). Every card has an explicit Save.
    - Pipeline stages: a repeater of label, tone (named swatches, chosen by name not colour), kind (Open, Won, Lost); the initial stage is locked; Move up / Move down plus optional drag; 2–10 stages; delete only when empty ("Move its {n} leads first").
    - Lead scoring: the closed signal list with points 0–50 each and the total capped at 100; "Scores above 75 show green."
    - Contact stages: the four, read-only, with the mockup's descriptions.
    - Custom fields: up to 12 rows of key, label, type; a warning that renaming a key orphans stored values.
    - Response time and assignment: SLA hours; rule Manual, Round robin (pool) or Always to one person. The Notifications architect's "Assignment rule" and "Answer within" fields write here.
    - Data & privacy: "Leads and contacts are kept {N} months after their last activity" (editable only by settings.general holders: 12, 18 or 24 months); "Erase a person's data" (crm.erase); the PDPL note "…Answer within 30 days."
    - The Email sending, WhatsApp Business and Sending rules cards are **not shown** (LATER).

**Sidebar badges** are server-rendered in AdminLayout on each Tier C render, gated by capability: Leads = initial-stage, non-spam count; Tasks = **my** overdue count. No polling.

## 12. Hooks for the LATER phase (designed, not built)

- **Conversations and messages**
  - `crm_conversations(contact_id, lead_id, channel, status open|waiting|closed, assigned_to, snoozed_until, last_message_at, version)` and `crm_messages(conversation_id, direction, kind message|note, body, author_id, delivery_status, template_id, provider_message_id unique)`.
  - Per-user read state: `crm_conversation_reads(user_id, conversation_id, read_at)`.
  - The timeline RPC gains a messages branch; `lead_events` and contact event kinds are extended (message_in, message_out, campaign_sent).
  - The WhatsApp 24-hour window and template-only rule are enforced on the server.
- **Templates:** `crm_message_templates(kind, name, category, subject/body {en, ar} or _ar scalars, buttons ≤3, wa_status per language, meta_template_id, version)`. Placeholders are filled on the server from contact, lead and `site_profile`, with `{brand}` as data, never hard-coded.
- **Segments:** `crm_segments(rules jsonb)` validated by a Zod rule schema that uses **the same filter vocabulary as `crm_contacts_list`**, so a saved filter is a segment. The server-side evaluator shares the contacts WHERE builder. Consent and unsubscribe are always applied for channel sends.
- **Consent:**
  - `crm_consent_events(contact_id, channel, granted, basis ∈ form-optin-v{version}|staff-attested|import-attested|written-request, evidence ≤500, policy_version, actor_id, at)`, append-only, with a derived current-consent view.
  - The public form needs two optional, versioned, bilingual opt-ins. The current `consent_marketing` checkbox is consent to reply, not marketing consent, and must never seed campaign consent.
  - The signed unsubscribe page uses a token keyed with a `crm-unsub/v1` labelled key, EN and AR, no-store, noindex.
  - Merge must keep both consent histories.
- **Suppressions:** `crm_suppressions(kind, value_hmac, reason, at)` survives erasure (HMAC only) and is fed by unsubscribe, bounces, STOP and erasure-with-do-not-contact.
- **Messaging settings:** `crm_messaging_settings` with its own capability (crm.messaging): sender name and address (defaulting to `site_profile.contact_email`), reply-to, signature {en, ar} with `{brand}`, WhatsApp number and display (defaulting to `site_profile`), business hours, away message {en, ar}, quiet hours, daily limit, unsubscribe footer {en, ar} (always on, locked). Provider secrets are Worker Secrets via astro:env only.
- **Import CSV:** a capability `crm.import` (Admin) and `POST /api/admin/crm/contacts/import`.
  - Server-side parse; at most 5000 rows and 2 MB; Zod per row; blind-index dedupe.
  - Per-channel consent attestation with evidence.
  - `claimPrivilegedOp` plus attempt and outcome audits with counts; `crm_import_batches`.
  - `source = 'import'` is already reserved.
- **Export & audiences:** the export.csv lockdown extended to contacts and segments; hashing on the server for ad audiences; exports listed from `audit_log` rows.
- **Reports:** `rollup_crm_daily` (leads per stage per day, won value, first response).
- **Files:** a **private** bucket with byte sniffing and an audited download (the applications pattern). Never the public A5 media bucket.
- **Future roles** (Marketer, Account manager): edit the per-capability helpers plus `ROLE_CAPS` and §5. Row-scoped Sales (only assigned leads) would be a policy change in `role_works_leads` callers.

## 13. Tests

**pgTAP** (supabase/tests). Every suite injects `sub` and seeds `auth.users` and `profiles` (the rls_job_applications pattern), because the live check needs them.

- **rls_leads.test.sql (rewritten):**
  - Each role × {select, update, insert, delete}.
  - anon → 42501.
  - Content Creator and SEO → 0 rows.
  - Admin and Developer (Sales from CRM-10) see the lead.
  - Admin of another tenant → 0 rows.
  - Demoted, deactivated or locked tokens → 0 rows and 0 updated rows.
  - UPDATE of email_enc, retention_delete_after or score → 42501; INSERT or DELETE → 42501.
  - leads_safe is security_invoker and has the expected columns.
  - The spam trigger caps retention, and clearing spam never extends it.
  - The legacy sync works in both directions.
  - Backfill postconditions hold.
- **rls_lead_pipeline.test.sql:** lead_stages and crm_settings per role (read: workers; write: crm.settings); lead_notes need leads.pii; lead_events can't be inserted by a user but are written by the triggers; the stage shape trigger rejects 1 stage, 11 stages, 0 won and 2 initial; a stage in use can't be deleted.
- **crm_ingest.test.sql:** `crm_ingest_lead`, `crm_link_lead` and the erase RPCs execute for service_role only (has_function_privilege); ingest creates the stage, events and score; a race on the same e-mail produces one contact; `crm_erase_person` leaves no row referencing the person's ids or blind indexes; ticked phone-only leads are erased and unticked ones remain.
- **rls_crm_contacts.test.sql** (and the tasks, companies and merge suites): six principals plus stale tokens; composite foreign keys refuse another tenant's ids; the merge RPC raises 40001 on version, P0002 or 42501 across tenants, writes its audit row in the same transaction and rolls back with no audit; `crm_people()` is empty for Content Creator and SEO, and lists colleagues for workers.
- **crm_retention.test.sql:** `app.run_retention()` actually deletes expired contacts, orphan auto-contacts, done tasks, tombstones and spam leads past spam_days, and keeps fresh ones.
- **rls_sales_role.test.sql** (CRM-10):
  - Sales reads leads, lead_notes, lead_events, contacts and tasks.
  - Sales reads zero rows of: site_settings, site_integrations, media_assets, redirects, custom_themes, draft services, blog and portfolio rows, page_sections drafts, content_versions, audit_log, system_logs, analytics_events, web_vitals, rollup_daily_pageviews, search_queries, consent_log, notification_log, job_applications, other profiles, privileged_ops.
  - Sales can insert its own audit row but not one with another actor_id.
  - Writing crm_settings or lead_stages fails.
  - A deactivated Sales token sees nothing.
  - 'sales' is in the enum; `is_staff()` is false for Sales.
- **Helper parity:** for every value of `enum_range(null::app_role)`, assert the expected boolean of each `app.role_*` helper (a literal copy of §5).
- **grants_app_schema.test.sql:** new `app.*` routines are not executable by anon.

**Vitest**
- `tests/authz/matrix.spec.ts`: the 6-cell parser, 5 roles, 36 caps, the new LABEL_TO_CAP entries, parsing architecture §3.4 too (D6), the four invariants, and the Sales must-not list.
- `tests/authz/sqlHelpers.spec.ts` (new): the last definition of each `app.role_*` across the migrations equals the holders in `ROLE_CAPS`.
- `tests/authz/endpoints.spec.ts`: a row for every new route (§9). Allow lists:
  - before CRM-10: leads.manage and leads.pii → admin, developer; crm.* → admin; export → admin, developer.
  - from CRM-10: leads.* → admin, developer, sales; crm.contacts and crm.tasks → admin, sales; crm.settings and crm.erase → admin.
  - Every existing row gains a Sales column asserting 403 automatically (it iterates `ROLES`). `other_tenant` coverage is automatic.
- `tests/lib/adminSecurity.spec.ts`: lead roles [admin, developer, sales]; the Sales menu equals Dashboard, Leads, Contacts and Tasks; Developer has no Contacts or Tasks.
- `tests/lib/crmBlindIndex.spec.ts`: normalisation (NFKC, case, IDN, Arabic-Indic digits, 05… → +9665…, 00 → +, rejects), labelled-key independence from the applicant and rate-limit keys, tenant salt, kind separation.
- `tests/lib/leadScore.spec.ts`: signals, the cap at 100, budget-derived reasons hidden from non-pii roles.
- `tests/api/leadsReveal.spec.ts`: audit failure → 403 with no plaintext; the 61st reveal → 429; liveRecheck demotion → 403; the legacy `?pii=1` behaves the same.
- `tests/api/leadsQuery.spec.ts`: response shape. No key from {email, phone, budget, timeline, notes, email_hmac, score_signals} ever appears in query, board, summary or lookup responses for any role.
- `tests/api/leadsWrite.spec.ts`: PATCH 409 on version; star and read don't bump the version; bulk writes N audit rows and returns conflicts; manual add encrypts, indexes and calls ingest, with a phone-duplicate 409; erase refused when the attempt audit fails.
- `tests/lib/createLead.spec.ts`: the RPC path, the fallback path, and no PII in system_logs.
- `tests/lib/crmIndexBackfill.spec.ts`: idempotent; batches of 500; undecryptable rows marked.
- `tests/lib/crmIcs.spec.ts`: escaping, folding, UTC, UID host, PRODID from site_profile, attachment, no-store, no contact name in the file.
- `tests/lib/crmTasksGrouping.spec.ts`: Riyadh day boundary (21:30Z counts as the next day).
- `tests/lib/exportBackup.spec.ts`: every CRM table is in FORBIDDEN.
- The log-scrub test: CRM error paths never log bodies, e-mails or phones.

**E2E** (Playwright, against the seeded local Supabase stack used by the e2e job, following the apply-roundtrip pattern)
- `tests/e2e/crm-roundtrip.e2e.ts`: a real contact-form POST produces ciphertext, email_hmac, the initial stage, a linked contact and a created event; nothing is reachable with the anon key.
- `tests/e2e/crm-roles.e2e.ts`: sessions are minted per role through the service key and a password sign-in, then call real endpoints. Sales gets 403 on export, settings, content, applications, audit, users, crm settings and erase. A demoted token reading via PostgREST directly gets 0 rows (§9 "Negative E2E proves server 403").
- axe (WCAG 2.2 AA) on /admin/leads, /admin/leads/board, a lead detail, /admin/contacts and /admin/tasks, including the keyboard Move to… path.
- csp e2e: zero `[style]` on the CRM pages.

## 14. Docs

- **CLAUDE.md:** §1(4), §3, §5, §7, §8, §9 and §10. The exact text is in claudeMdAmendments.
- **docs/architecture.md:**
  - §2.5 Leads, rewritten.
  - A new §2.11 CRM.
  - §3.4: the table in the §5 format with a Sales column, parsed by the test; the stale code block replaced (D6).
  - §3.6: helpers and the live check.
  - §3.7: the live-recheck list adds reveal and erase.
  - §4.7: notes, blind indexes, Sales.
  - §8.3: the contacts horizon.
  - §9.3: points at endpoints.spec, Sales rows.
  - §10: risks R-new — the stale token closed for the CRM; erasure versus backups.
- **docs/retention.md:** rows for contacts, tasks, tombstones, notes and events; spam marked as implemented; the after-last-activity basis flagged for legal.
- **Decisions doc:** the program's Admin v2 decisions doc gets a section "CRM core and the Sales role" with numbered decisions CRM-1 to CRM-n (each mockup deviation with its reason) and a Mockup | Site | Where table, the way the Join section of design-port-2026-09.md does it.
- **docs/launch-runbook.md:** the order for migrations 0037 and 0038; a step to invite a Sales user and verify its JWT claim; the staging check that the pg_cron role bypasses RLS.

## 15. Slice order and rollout

| Slice | Content |
|---|---|
| CRM-1 | Leads schema |
| CRM-2 | Read API |
| CRM-3 | Write API |
| CRM-4 | Leads UI |
| CRM-5 | Contacts schema |
| CRM-6 | Contacts API |
| CRM-7 | Contacts UI |
| CRM-8 | Tasks |
| CRM-9 | Settings |
| CRM-10 | **Sales** |
| CRM-11 | Companies |
| CRM-12 | Merge |
| CRM-13 | Attribution |
| CRM-14 | Contract |

- One branch and PR per slice; CI green; Claude never merges.
- Migrations are applied to production before each deploy (deploy guard).
- Migration numbers are provisional: other Admin v2 slices also add migrations, so take the next free number at branch time (0030 if CRM-1 is first).
- The contract slice (CRM-14) waits at least one release after CRM-4 and CRM-10, so old Worker versions in the field never write `status` or `internal_notes` against a dropped column.

### Critical files for implementation

- supabase/migrations/0030_crm_leads_pipeline.sql (new; the leads expand migration, helpers, live check, grants)
- src/lib/authz/matrix.ts and tests/authz/matrix.spec.ts (capabilities, Sales row, the 6-cell parser and the architecture §3.4 parse)
- src/lib/data/leads.ts (createLead → crm_ingest_lead with fallback) and src/lib/applications/keys.ts (CRM_INDEX_LABEL)
- src/pages/api/admin/leads/[id].ts (fail-closed reveal, notes, versioned PATCH; the D1 fix)
- CLAUDE.md (§1, §3, §5, §7, §8, §9, §10 amendments)

## Slices (design ids)

### CRM-1: Leads v2 schema: pipeline stages, spam flag, notes thread, timeline, live check, column grants, ingest RPC

**Depends on:** none · **Effort:** L

Migration 0030 is expand-only. It adds: app.live_role(); the six per-capability helpers (app.role_works_leads, role_lead_pii, role_crm_contacts, role_crm_tasks, role_crm_settings, role_crm_erase) with today's role lists; lead_stages (seeded New/Contacted/Proposal sent/Won/Lost; fixed tone palette; kinds; one initial; deferred shape trigger); the crm_settings singleton (seeded); the new leads columns (stage_id with a composite FK, is_spam, assigned_to with a composite FK to profiles(tenant_id,id), value_sar, is_starred, read_at/read_by, tags, score/score_signals, first_response_at, won_at, last_contact_at/channel, email_hmac/phone_hmac, crm_indexed_at, source, channel, attribution columns left unwritten, actor columns, version, and a generated search_text with a trgm index); a nullable email_enc with a has-a-channel CHECK; unique (tenant_id,id) on leads and profiles. Triggers: legacy status<->stage sync, spam retention (fixes D2), a lead-specific version bump, actor, pipeline stamps, a definer AFTER-UPDATE timeline writer, the legacy internal_notes mirror, the assignee check. lead_notes is backfilled from internal_notes and gated by leads.pii; lead_events has no user INSERT grant. Lead policies are rewritten through the helpers plus a RESTRICTIVE live policy (fixes D5). Leads UPDATE is narrowed to a column grant (fixes D3). leads_safe is re-created with appended columns and a postcondition DO block. public.crm_ingest_lead is service_role only. App side: src/lib/crm/{normalize,blindIndex,score}.ts; hmacHex moves to src/lib/crypto/hmac.ts; CRM_INDEX_LABEL is added; createLead calls the ingest RPC with a legacy-insert fallback; the Worker daily cron backfills blind indexes and signals in batches of 500. The existing LeadsPanel, API, export and dashboard keep working through the sync trigger. Docs: CLAUDE.md §3/§8 lead bullets (the notes thread, the column grant, the live check, spam implemented, the leads_safe truth, D7); the two lead rows relabelled in §5, matrix.ts LABEL_TO_CAP and architecture §3.4; retention.md (spam implemented); the decisions-doc section skeleton.

**Key files:**

- supabase/migrations/0030_crm_leads_pipeline.sql
- src/lib/data/leads.ts
- src/lib/crm/normalize.ts
- src/lib/crm/blindIndex.ts
- src/lib/crm/score.ts
- src/lib/crypto/hmac.ts
- src/lib/http/publicRateLimit.ts
- src/lib/applications/keys.ts
- src/lib/cron/daily.ts
- src/lib/crm/indexBackfill.ts
- packages/schemas/crm.ts
- src/lib/admin/leadFields.ts
- src/lib/admin/backupTables.ts
- supabase/tests/rls_leads.test.sql
- supabase/tests/rls_lead_pipeline.test.sql
- supabase/tests/crm_ingest.test.sql
- CLAUDE.md
- docs/architecture.md
- docs/retention.md

**Migrations:**

- 0030_crm_leads_pipeline.sql (next free number at branch time)

**Tests:**

- pgTAP rls_leads.test.sql rewritten with sub and profiles: six principals; demoted, deactivated and locked tokens see 0 rows; UPDATE of email_enc, retention_delete_after or score fails with 42501; INSERT and DELETE fail with 42501; leads_safe is security_invoker with the exact column set
- pgTAP rls_lead_pipeline.test.sql: lead_stages and crm_settings per role; lead_notes require leads.pii; lead_events reject user inserts but the triggers write; stage shape trigger rejects bad sets; a stage in use cannot be deleted
- pgTAP: spam trigger caps retention at now()+spam_days and clearing spam never extends it; legacy sync maps old status writes to stages and new stage writes back to status; every lead has a stage; internal_notes is copied into lead_notes
- pgTAP crm_ingest.test.sql: crm_ingest_lead executes for service_role only; it creates the initial stage, a created event and the score
- pgTAP helper parity: each app.role_* returns the expected value for every enum role
- grants_app_schema: new app.* routines are not executable by anon
- vitest crmBlindIndex: normalisation, tenant salt, kind separation, independence from the applicant and rate-limit labels
- vitest leadScore: signals, cap 100
- vitest createLead: RPC path, fallback path, no PII in system_logs
- vitest crmIndexBackfill: idempotent, batched, undecryptable rows marked
- vitest exportBackup: lead_notes, lead_events, lead_stages and crm_settings are forbidden
- tests/authz/sqlHelpers.spec.ts (new): the last helper definition in the migrations mirrors ROLE_CAPS
- matrix.spec: relabelled LABEL_TO_CAP entries

**Risks:**

- Expand window: old Worker code writes status and internal_notes; the sync and mirror triggers must keep both models consistent until CRM-14
- The legacy 'done' backfill target is an owner decision (O3); it is recorded as legacy_backfill events so it can be reversed
- FORCE RLS plus definer triggers inserting into lead_events depends on the no-TO insert policy (0009 precedent); pgTAP must prove it
- The live check changes every pgTAP leads fixture (sub and profiles now needed)
- Relaxing email_enc NOT NULL; notify-lead and export must tolerate a null e-mail
- Generated search_text recomputes on every write as the writer, so authenticated needs EXECUTE on app.normalize_ar (already granted)

### CRM-2: Leads API, read side: query/board/summary RPCs, detail with notes and timeline, fail-closed audited reveal, notes, people directory

**Depends on:** CRM-1 · **Effort:** M

Migration 0031 adds the INVOKER RPCs leads_list, leads_board, lead_summary and lead_neighbours (safe projections only, search_text trigram or exact blind-index match, bounded) and the DEFINER crm_people(). Routes:
- POST /api/admin/leads/query, /summary, /board, /[id]/neighbours
- GET /api/admin/leads/[id]: detail, notes for leads.pii holders, first events page; sets read_at; audits lead.view
- GET /[id]/events
- POST /[id]/reveal: liveRecheck; claimPrivilegedOp 'pii-reveal' at 60 per hour per user and 300 per hour per tenant; writeAudit lead.view_pii directly and fail-closed BEFORE decrypting (fixes D1)
- POST /[id]/notes
- GET /api/admin/crm/people
- GET /api/admin/crm/stages
The legacy GET ?pii=1 gets the same fail-closed and rate-limit behaviour. The legacy PATCH internalNotes returns 422 (fixes D4). Search runs as a POST body and q is never kept in the URL (fixes D9 and D10). Dashboard counts (dashboard.ts, admin/index.astro) move to initial-stage and non-spam. Interest labels resolve as today. packages/schemas/crm.ts holds the filter schemas, with q at most 64 characters through cleanQuery.

**Key files:**

- supabase/migrations/0031_crm_leads_queries.sql
- src/pages/api/admin/leads/query.ts
- src/pages/api/admin/leads/summary.ts
- src/pages/api/admin/leads/board.ts
- src/pages/api/admin/leads/[id].ts
- src/pages/api/admin/leads/[id]/reveal.ts
- src/pages/api/admin/leads/[id]/notes.ts
- src/pages/api/admin/leads/[id]/events.ts
- src/pages/api/admin/crm/people.ts
- src/pages/api/admin/crm/stages.ts
- src/lib/admin/rateLimit.ts
- src/pages/api/admin/dashboard.ts
- src/pages/admin/index.astro
- packages/schemas/crm.ts
- tests/authz/endpoints.spec.ts

**Migrations:**

- 0031_crm_leads_queries.sql

**Tests:**

- endpoints.spec rows for every new route: leads.manage and leads.pii allow admin and developer; other_tenant is covered automatically
- vitest leadsReveal: a failed audit insert gives 403 and no plaintext; the 61st reveal in an hour gives 429; liveRecheck demotion gives 403; the legacy ?pii=1 behaves the same
- vitest leadsQuery: response-shape test that no key from email, phone, budget, timeline, notes, email_hmac or score_signals appears in query, board or summary responses
- vitest: a full e-mail search uses the blind index, never ilike; a metacharacter-heavy q is handled safely (§9(e))
- pgTAP: crm_people() is empty for content_creator and seo and lists colleagues for lead workers; list RPCs return 0 rows across tenants and under stale tokens

**Risks:**

- The reveal rate limit could annoy heavy users; the limits are an owner item (O5)
- GET detail sets read_at (an idempotent write in a GET) and writes an audit row on every open
- The RPC output columns must stay within the safe set; pinned by the response-shape test

### CRM-3: Leads API, write side: versioned PATCH, bulk with per-lead audit, manual add via service-role ingest, erase, export filters, crm.erase capability

**Depends on:** CRM-2 · **Effort:** M

Migration 0032 adds the INVOKER leads_bulk_update (applied rows come back, the rest are conflicts) and the service_role-only crm_erase_lead.
- PATCH /api/admin/leads/[id]: version required for stageId, assignedTo, valueSar and tags; isStarred, read and logContact are unversioned.
- POST /api/admin/leads/bulk: at most 100 {id,version}; actions assign, stage, read, star, spam, tagAdd, tagRemove; one audit row per lead through a new writeAuditMany.
- POST /api/admin/leads (manual add): needs leads.manage and leads.pii; encrypts and indexes, then calls the service-role ingest with source manual, a channel and first_response_at = created_at; a phone-only match returns a 409 possible-duplicate.
- POST /[id]/erase: crm.erase; liveRecheck; claimPrivilegedOp 'crm-erase' at 20 per hour per user and 50 per hour per tenant; fail-closed attempt audit, then the RPC, then an outcome audit.
- DELETE /[id]/notes/[noteId]: crm.erase.
- The export (export.csv, same holders) accepts the list filters and adds stage, assignee, value, tags, score, source and channel; note bodies are dropped in favour of notes_count.
New capability crm.erase (Admin) in matrix.ts, CLAUDE.md §5, architecture §3.4 and matrix.spec (33 capabilities).

**Key files:**

- supabase/migrations/0032_crm_leads_erase.sql
- src/pages/api/admin/leads/[id].ts
- src/pages/api/admin/leads/bulk.ts
- src/pages/api/admin/leads/index.ts
- src/pages/api/admin/leads/[id]/erase.ts
- src/pages/api/admin/leads/export.ts
- src/lib/admin/audit.ts
- src/lib/authz/matrix.ts
- tests/authz/matrix.spec.ts
- packages/schemas/crm.ts
- CLAUDE.md

**Migrations:**

- 0032_crm_leads_erase.sql

**Tests:**

- endpoints.spec rows: PATCH, bulk and manual add allow admin and developer; erase and note delete allow admin only
- vitest leadsWrite: PATCH returns 409 on a version mismatch; star and read do not bump the version; bulk returns applied and conflicts and writes N audit rows; manual add encrypts, indexes and calls ingest; a phone duplicate returns 409
- vitest: erase is refused with no RPC call when the attempt audit fails; the rate limit gives 429
- pgTAP: crm_erase_lead is service_role only and removes the lead, its notes and events and tasks on it
- matrix.spec: 33 caps, crm.erase is Admin only
- exportBackup and export tests: filters applied server-side; no note bodies

**Risks:**

- Bulk with per-row versions gives partial success; the UI must explain the conflicts
- Manual phone-only leads rely on the relaxed email_enc constraint
- Dropping note bodies from the CSV changes existing export content and must be recorded in the decisions doc

### CRM-4: Leads v2 UI: list with KPIs and bulk bar, pipeline board with a keyboard Move-to path, lead detail, add-lead drawer

**Depends on:** CRM-3, ext:admin-v2-ui-kit · **Effort:** L

Rewrites LeadsPanel into the LeadsList, LeadsBoard and LeadDetail islands on the Admin v2 primitives, at /admin/leads, /admin/leads/board and /admin/leads/[id], per UI contract §11 items 1 to 4.
- No budget column; masked contact details with the audited reveal; mailto, tel and wa.me links only after a reveal; Log contact.
- The notes thread and the timeline; stage tones through data-tone; the score through data-width buckets; avatars through data-av; Move to… with aria-live.
- Filter state in the URL except q; 409 handling.
- Export CSV link only for export.csv holders, carrying the filters.
- The Add-lead drawer.
- The sidebar Leads badge (initial-stage, non-spam count) server-rendered in AdminLayout.
- New islands added to both .size-limit.json lists.

**Key files:**

- src/pages/admin/leads/index.astro
- src/pages/admin/leads/board.astro
- src/pages/admin/leads/[id].astro
- src/components/admin/crm/LeadsList.tsx
- src/components/admin/crm/LeadsBoard.tsx
- src/components/admin/crm/LeadDetail.tsx
- src/components/admin/crm/AddLeadDrawer.tsx
- src/layouts/AdminLayout.astro
- src/lib/admin/nav.ts
- public/styles/admin.css
- .size-limit.json

**Tests:**

- axe WCAG 2.2 AA on the list, board and detail, including the keyboard Move-to path and dialog focus return
- csp e2e: zero [style] attributes on the CRM pages
- unit: interestOf and the formatting helpers moved to src/lib/admin; the reveal state is not persisted
- e2e crm-roundtrip: a form submission appears in the list with no PII columns
- size-limit: admin bundle stays within 300 KB gz and the new facades are excluded from the public budget

**Risks:**

- Depends on the UI program's primitives and the contrast-fixed tone colours
- Admin bundle headroom (about 82 KB); no dnd or chart library
- Board drag-and-drop must not use inline transforms

### CRM-5: Contacts schema: contacts, channels, notes, events; ingest links leads to contacts; backfill; retention; person erasure

**Depends on:** CRM-3 · **Effort:** L

Migration 0033 adds:
- tables crm_contacts (name_key and search_text generated; no stored value or score), crm_contact_channels (ciphertext under LEAD_PII_ENC_KEY copied from leads, blind indexes, one e-mail per tenant, primary flags), crm_contact_notes and crm_contact_events;
- leads.contact_id with a composite FK and ON DELETE SET NULL (contact_id), its UPDATE grant and the leads_safe append;
- triggers for activity bumps, a won lead turning its contact into a client, the assignee filling an empty owner, and the event writers;
- RLS through role_crm_contacts plus the live check;
- INVOKER crm_create_contact and crm_update_contact;
- crm_ingest_lead v2 (race-safe contact upsert by e-mail blind index, phone channel, returning signal);
- service-role crm_link_lead, crm_erase_preview and crm_erase_person;
- app.purge_crm called from app.run_retention (contacts past last activity plus leads_months, orphan auto-contacts).
The Worker cron links unlinked leads without decrypting. New capability crm.contacts (Admin) plus the invariant tests. CRM tables go into FORBIDDEN_BACKUP_TABLES. Docs: CLAUDE.md §3 CRM bullet and §8 CRM data-model bullet; retention.md rows; privacy-notice change flagged (O4).

**Key files:**

- supabase/migrations/0033_crm_contacts.sql
- src/lib/data/leads.ts
- src/lib/crm/linkBackfill.ts
- src/lib/cron/daily.ts
- src/lib/admin/backupTables.ts
- src/lib/authz/matrix.ts
- tests/authz/matrix.spec.ts
- supabase/tests/rls_crm_contacts.test.sql
- supabase/tests/crm_retention.test.sql
- CLAUDE.md
- docs/retention.md

**Migrations:**

- 0033_crm_contacts.sql

**Tests:**

- pgTAP rls_crm_contacts: six principals plus stale tokens on contacts, channels, notes and events; composite FKs refuse another tenant's ids
- pgTAP crm_ingest v2: two concurrent leads from the same new e-mail produce one contact; phone matches are not auto-linked
- pgTAP crm_erase_person: afterwards no row references the person's ids or e-mail blind indexes; ticked phone-only leads are erased and unticked ones kept; service_role only
- pgTAP crm_retention: run_retention deletes expired contacts and orphan auto-contacts and keeps active ones
- vitest linkBackfill: idempotent; no decrypt needed
- matrix.spec invariants: crm.contacts implies leads.manage and leads.pii
- exportBackup: CRM tables are forbidden

**Risks:**

- Retention based on last activity extends how long a person's e-mail is kept compared with today; needs legal sign-off (O4)
- The contact ciphertext shares the lead key by design; key rotation must cover both tables
- Erasure by phone is deliberately manual, so the Admin must review the preview

### CRM-6: Contacts API: query/summary/lookup, detail and timeline, add, edit, notes, reveal, bulk, new lead for a contact, erase

**Depends on:** CRM-5 · **Effort:** M

Migration 0034 adds the INVOKER crm_contacts_list (derived value and score, expires_at, Expiring-soon filter), crm_contact_summary and crm_contact_timeline (UNION, keyset, limit 60). Routes under /api/admin/crm/contacts: query, summary, lookup (at most 8 results, no e-mail or phone), create, detail (channel presence only), PATCH (version; channel edits are live-rechecked), reveal (shared pii-reveal limiter, fail-closed crm.contact.view_pii), notes, timeline, bulk (per-contact audit), [id]/leads (new lead from the contact's ciphertext), erase-preview and erase (crm.erase, §8.2). Custom field values are validated against crm_settings.custom_fields. Duplicate e-mail returns 409 with the contactId.

**Key files:**

- supabase/migrations/0034_crm_contacts_queries.sql
- src/pages/api/admin/crm/contacts/query.ts
- src/pages/api/admin/crm/contacts/index.ts
- src/pages/api/admin/crm/contacts/[id].ts
- src/pages/api/admin/crm/contacts/[id]/reveal.ts
- src/pages/api/admin/crm/contacts/[id]/timeline.ts
- src/pages/api/admin/crm/contacts/[id]/erase.ts
- src/pages/api/admin/crm/contacts/lookup.ts
- packages/schemas/crm.ts
- tests/authz/endpoints.spec.ts

**Migrations:**

- 0034_crm_contacts_queries.sql

**Tests:**

- endpoints.spec rows: crm.contacts routes allow admin; erase allows admin; [id]/leads requires leads.manage, leads.pii and crm.contacts
- vitest: contact reveal is fail-closed on audit failure, rate-limited, and liveRecheck demotion gives 403
- vitest: lookup, query and timeline responses never contain e-mail, phone or channel values
- vitest: custom field values are rejected against the definitions (type, bounds, unknown key)
- pgTAP: the timeline hides lead notes from roles without leads.pii and returns 0 rows across tenants

**Risks:**

- The timeline UNION's performance at scale (keyset plus limit)
- Explicit-save forms against the mockup's autosave; recorded as a deviation

### CRM-7: Contacts UI: People list, contact detail with timeline, add-contact drawer, erase dialog

**Depends on:** CRM-6, CRM-4 · **Effort:** L

Islands ContactsList, ContactDetail, AddContactDrawer and EraseDialog per UI contract §11 items 5 to 8, at /admin/contacts and /admin/contacts/[id].
- The People tab only (Companies arrives in CRM-11; Segments is hidden).
- Stage chips, filters and the Expiring-soon chip; the bulk bar has no export or delete.
- Masked contact details with the audited reveal.
- The timeline with the note composer ('Only your team sees notes.'); explicit Save on Details.
- No Consent card, Files card, Import or Export.
The sidebar Contacts item is gated on crm.contacts. Islands go into both size-limit lists.

**Key files:**

- src/pages/admin/contacts/index.astro
- src/pages/admin/contacts/[id].astro
- src/components/admin/crm/ContactsList.tsx
- src/components/admin/crm/ContactDetail.tsx
- src/components/admin/crm/AddContactDrawer.tsx
- src/components/admin/crm/EraseDialog.tsx
- src/lib/admin/nav.ts
- .size-limit.json

**Tests:**

- axe on /admin/contacts and the contact detail
- csp e2e: zero [style] attributes
- unit: the erase dialog requires the second confirm and the reason
- size-limit within budget

**Risks:**

- The client may push for the consent toggles shown in the mockup (O-items); they are deferred deliberately

### CRM-8: Tasks: crm_tasks, server-side grouping in the tenant time zone, task drawer, server-generated .ics, my-overdue badge

**Depends on:** CRM-6, ext:admin-v2-ui-kit · **Effort:** M

Migration 0035 adds crm_tasks (composite FKs to contact and lead, owner check, version), RLS through role_crm_tasks plus the live check, triggers writing task events, crm_tasks_grouped(view, tz), the snooze computation in SQL, and purge rules added to app.purge_crm. New capability crm.tasks (Admin) plus the invariant crm.tasks implies crm.contacts. Routes: GET/POST /api/admin/crm/tasks, PATCH/DELETE /[id], GET /[id]/ics (PRODID from site_profile, UID host from PUBLIC_SITE_URL, title and admin link only). The TasksPanel island and task drawer (due date and time). The sidebar badge counts my overdue tasks, server-rendered. The lead and contact detail pages show a Tasks card.

**Key files:**

- supabase/migrations/0035_crm_tasks.sql
- src/pages/api/admin/crm/tasks/index.ts
- src/pages/api/admin/crm/tasks/[id].ts
- src/pages/api/admin/crm/tasks/[id]/ics.ts
- src/lib/crm/ics.ts
- src/components/admin/crm/TasksPanel.tsx
- src/pages/admin/tasks.astro
- src/layouts/AdminLayout.astro
- src/lib/authz/matrix.ts

**Migrations:**

- 0035_crm_tasks.sql

**Tests:**

- pgTAP rls_crm_tasks: six principals plus stale tokens; owner check; tasks cascade with their contact or lead
- vitest crmTasksGrouping: the Riyadh day boundary and snooze to tomorrow 10:00 in the tenant time zone
- vitest crmIcs: escaping, 75-octet folding, UTC, attachment, no-store, PRODID and UID from data, no contact name or note in the file
- endpoints.spec rows for the task routes: crm.tasks allows admin
- matrix.spec: 35 caps and the invariants
- axe on /admin/tasks

**Risks:**

- Time-zone arithmetic: the browser may not be in Riyadh, so conversion happens only on the server
- Overdue badge semantics ('mine') differ from the mockup's 'everyone' (O10)

### CRM-9: CRM settings: stages editor, scoring points with recompute, custom contact fields, response time and assignment

**Depends on:** CRM-4, CRM-7 · **Effort:** M

Migration 0036 adds:
- save_lead_stages(p_stages, p_version), an INVOKER upsert, reorder and delete-unused, backed by the deferred shape trigger;
- save_crm_settings(p_patch, p_version);
- app.recompute_lead_scores(), a DEFINER with an internal live crm.settings check;
- the assignment step in crm_ingest_lead (manual, round_robin with the pool and an atomic rr_cursor, or fixed).
New capability crm.settings (Admin) for the 36-capability total. Routes: GET/PUT /api/admin/crm/settings and PUT /api/admin/crm/stages. The CrmSettingsPanel island covers the pipeline stages, lead scoring, contact stages (read-only), custom fields, response time and assignment, and Data & privacy (retention through the settings.general endpoint; the Erase button). Messaging cards are not built.

**Key files:**

- supabase/migrations/0036_crm_settings_rpcs.sql
- src/pages/api/admin/crm/settings.ts
- src/pages/api/admin/crm/stages.ts
- src/components/admin/crm/CrmSettingsPanel.tsx
- src/pages/admin/crm/settings.astro
- packages/schemas/crm.ts
- src/lib/authz/matrix.ts
- tests/authz/matrix.spec.ts

**Migrations:**

- 0036_crm_settings_rpcs.sql

**Tests:**

- pgTAP: save_lead_stages enforces 2 to 10 stages, one initial, at least one won and one lost, and refuses deleting a stage in use (409); save_crm_settings returns 40001 on a stale version; recompute updates every lead's score; a non-settings role gets 42501
- vitest: the scoring schema rejects unknown keys and points outside 0 to 50; custom fields are limited to 12 with unique snake_case keys; the time-zone allowlist
- endpoints.spec: settings and stages PUT allow admin only; stages GET allows lead workers
- pgTAP: round-robin assigns in pool order and skips inactive members

**Risks:**

- Recomputing scores on large tenants (a single UPDATE; fine at around 10^4 leads)
- Deleting a custom field orphans stored values; the UI warns

### CRM-10: Sales role: 5th app_role, helper and policy edits, ROLE_CAPS, docs and every authz test

**Depends on:** CRM-4, CRM-7, CRM-8, CRM-9 · **Effort:** M

Migration 0037_app_role_sales.sql contains only ALTER TYPE public.app_role ADD VALUE 'sales'. Every use of the value goes in 0038_sales_role.sql (55P04 caveat):
- app.is_member();
- audit_insert rewritten to is_member() and actor_id = auth.uid();
- role_works_leads, role_lead_pii, role_crm_contacts and role_crm_tasks re-created with sales;
- is_staff() deliberately unchanged;
- postconditions.
TypeScript: ROLES, RoleSchema and a ROLE_CAPS sales row; UsersPanel imports ROLES and gains role labels and descriptions; notify-lead recipients derived from leads.manage holders (fixes D8); nav.ts gets the CRM group and Dashboard caps analytics.read or leads.manage; the topbar search is hidden when nothing is searchable. Docs: CLAUDE.md §1(4), §3, §5 (table and canonical role paragraph), §7, §8, §9; architecture §3.3, §3.4 (rewritten in the §5 format and parsed, fixing D6), §3.6, §3.7, §9.3; the runbook steps for migration order, inviting a Sales user and verifying the JWT claim.

**Key files:**

- supabase/migrations/0037_app_role_sales.sql
- supabase/migrations/0038_sales_role.sql
- src/lib/auth/types.ts
- src/lib/authz/matrix.ts
- packages/schemas/admin.ts
- src/components/admin/UsersPanel.tsx
- src/pages/api/hooks/notify-lead.ts
- src/lib/admin/nav.ts
- tests/authz/matrix.spec.ts
- tests/authz/endpoints.spec.ts
- tests/lib/adminSecurity.spec.ts
- supabase/tests/rls_sales_role.test.sql
- CLAUDE.md
- docs/architecture.md
- docs/launch-runbook.md

**Migrations:**

- 0037_app_role_sales.sql (ALTER TYPE only, alone)
- 0038_sales_role.sql

**Tests:**

- matrix.spec: 6-cell parser, 5 roles, 36 caps, new labels; parses architecture §3.4 as well (D6); invariants; Sales must-not list (content, settings, exports, applications, logs, audit, site health, users, analytics, crm.settings, crm.erase)
- sqlHelpers.spec: helper role lists equal the ROLE_CAPS holders including sales
- endpoints.spec: CRM rows' allow lists gain sales where §2 says so; every existing row asserts Sales gets 403 automatically; other_tenant unchanged
- adminSecurity.spec: lead roles are admin, developer and sales; the Sales menu is Dashboard, Leads, Contacts and Tasks; every role's menu is non-empty
- pgTAP rls_sales_role: Sales reads CRM tables and zero rows of every is_staff() and Admin/Developer table listed in §13; writes its own audit row but not another actor's; a deactivated Sales token sees nothing; 'sales' is in the enum; is_staff() is false for Sales
- e2e crm-roles: a real Sales session gets 403 on export, settings, content writes, applications, audit, users, crm settings and erase; a demoted token reading PostgREST directly gets 0 rows
- UsersPanel unit: invite with role sales passes RoleSchema

**Risks:**

- The ALTER TYPE transaction caveat: the value is unusable until committed and the enum value can never be dropped
- The TypeScript must deploy together with the migrations or Sales sessions fail closed (DENY_ANON); the deploy guard enforces the order
- A role change mid-session forces a fresh sign-in (divergence denies)
- Any future policy written with is_member() instead of a capability helper would widen Sales; review rule: is_member is for audit_insert only

### CRM-11: Companies: crm_companies, Companies tab and drawer, contact company link

**Depends on:** CRM-7, CRM-10 · **Effort:** M

Migration 0039 adds crm_companies (sector link to the public sectors taxonomy with a tenant check; optional client_id link to the public clients row, a link only) and crm_contacts.company_id with a composite FK and ON DELETE SET NULL (company_id); RLS through role_crm_contacts plus the live check. Routes for companies query, create, PATCH and DELETE (crm.contacts, audited). The Companies tab: name, website, sector, city, contact count, stage, total won value, owner. The company drawer saves explicitly with a version. 'Create company from this name' on contacts. The head sub-line counts companies.

**Key files:**

- supabase/migrations/0039_crm_companies.sql
- src/pages/api/admin/crm/companies/query.ts
- src/pages/api/admin/crm/companies/[id].ts
- src/components/admin/crm/CompaniesTab.tsx
- packages/schemas/crm.ts

**Migrations:**

- 0039_crm_companies.sql

**Tests:**

- pgTAP rls_crm_companies: six principals plus stale tokens; cross-tenant sector, client and contact links are refused
- endpoints.spec rows: admin and sales allowed
- vitest: website must be https and within 2048 characters; company totals are derived

**Risks:**

- Confusion with the public clients list; the UI states that linking does not publish anything

### CRM-12: Merge duplicates: server-side finder, transactional INVOKER merge with tombstone, dismissals

**Depends on:** CRM-7, CRM-10 · **Effort:** M

Migration 0040 adds:
- crm_merge_dismissals;
- crm_duplicate_pairs(limit), finding pairs by the same phone blind index, the same non-freemail domain blind index plus name_key trigram similarity of at least 0.6 or the same first token, or the same name_key plus company; dismissed pairs and tombstones excluded;
- crm_merge_contacts(keep, keepVersion, drop, dropVersion), SECURITY INVOKER with rows locked in id order, version 40001 and the tenant fence. It moves channels, leads, tasks, notes and events, fills blanks, unions tags, takes stage precedence, turns the dropped record into a scrubbed tombstone (no DELETE grant needed) and inserts the audit_log row in the same transaction.
Tombstones are purged by app.purge_crm. Routes: duplicates, merge, dismiss (crm.contacts). The merge modal shows no contact values.

**Key files:**

- supabase/migrations/0040_crm_merge.sql
- src/pages/api/admin/crm/duplicates.ts
- src/pages/api/admin/crm/contacts/merge.ts
- src/components/admin/crm/MergeDialog.tsx

**Migrations:**

- 0040_crm_merge.sql

**Tests:**

- pgTAP: merge returns 40001 on either version; another tenant's id gives P0002 or 42501; channels and leads move; the tombstone is scrubbed; the audit row exists and a forced failure rolls everything back; a dismissed pair no longer appears
- pgTAP: the finder uses indexes and returns at most 50 rows
- endpoints.spec rows: admin and sales allowed

**Risks:**

- False positives from name similarity; mitigated by human review and dismissals
- Unmerge is not supported; the confirm text says so

### CRM-13: Lead attribution capture (consent-gated) and privacy notice update

**Depends on:** CRM-2 · **Effort:** M

Blocked until legal signs off the notice (O4). landing_path is derived on the server from the same-origin Referer of the POST, with no client trust. referrer_host, utm_*, device_class and country are captured only when hasConsent('analytics') holds: the client stores first-touch values in sessionStorage only with consent, and the server re-checks the __Host-consent cookie through the single gate. Channel classification happens on the server. The service_page score signal becomes active. LeadInputSchema gains a strict, bounded, optional attribution object. The privacy notice (src/lib/legal/content.ts, EN and AR) gets a version bump. The leads list Source filter and badges and the lead detail rows light up. IP, city, full URLs and session linkage are never captured.

**Key files:**

- src/pages/api/contact.ts
- packages/schemas/lead.ts
- src/lib/data/leads.ts
- packages/consent/gate.ts
- src/lib/legal/content.ts
- src/components/ContactForm.astro

**Tests:**

- vitest: without consent, attribution fields are dropped and channel is unknown; with consent, the values are stored and bounded
- vitest: landing_path ignores client input and strips the query
- e2e: no attribution sessionStorage write before consent; public bundle stays within 100 KB
- served-html and legal tests: the notice version bumped in EN and AR

**Risks:**

- PDPL: needs legal sign-off and the notice published first
- Adds bytes to public routes (expected under 1 KB)

### CRM-14: Contract: drop legacy status/internal_notes/ip_inet, remove the ?pii=1 alias and the old list GET

**Depends on:** CRM-4, CRM-10 · **Effort:** S

After at least one release with no legacy writers, migration 0041 drops the sync and legacy-notes triggers, revokes UPDATE on status and internal_notes, and drops the status CHECK and column, internal_notes and ip_inet (never written). leads_safe is dropped and re-created inside one transaction with grants and postconditions (security_invoker, safe columns). The legacy GET ?pii=1 alias and GET /api/admin/leads are removed. leadFields.ts, the export and notify-lead are updated. consent_marketing may be renamed to consent_contact through an expand/contract view alias.

**Key files:**

- supabase/migrations/0041_crm_leads_contract.sql
- src/lib/admin/leadFields.ts
- src/pages/api/admin/leads/[id].ts
- src/pages/api/admin/leads/index.ts
- src/pages/api/hooks/notify-lead.ts
- supabase/tests/rls_leads.test.sql

**Migrations:**

- 0041_crm_leads_contract.sql

**Tests:**

- pgTAP: leads_safe is still security_invoker with the exact columns; the removed columns are gone; the grants postconditions hold
- endpoints.spec: the removed routes are gone from CASES
- vitest: notify-lead and the export work without the dropped columns

**Risks:**

- Old Worker versions still in the field would write dropped columns; wait one release and check that the deploy guard has run
- Dropping and re-creating leads_safe must restate security_invoker or every authenticated role reads all leads (0015 warning)

## Proposed standard amendments

- §1(4) (CRM-10): '4 roles: Admin, Content Creator, SEO, Developer' becomes '5 roles: Admin, Content Creator, SEO, Developer, Sales (added in Admin v2, owner decision A4, 2026-10-03)'.
- §3 Pillar 1, replace the leads.budget/timeline bullet (CRM-1, Sales added in CRM-10): 'Lead PII: budget, timeline (encrypted) and the notes thread (lead_notes, which replaced internal_notes in 0030) are readable only by leads.pii holders in both layers (Admin, Developer, Sales). Contact details, budget and timeline leave the database only through the per-lead reveal, which is live-rechecked, rate-limited (60/h per user, 300/h per tenant, op pii-reveal) and audited fail-closed before decrypting, or through the export lockdown (export.csv). Lists, boards, KPIs, lookups and search never carry them. E-mail and phone search is exact-match through HMAC blind indexes (labelled crm-index/v1 derivation of LEAD_PII_ENC_KEY, tenant-salted; no new secret). leads_safe is SECURITY INVOKER: RLS decides who sees rows, because a GRANT cannot tell the app roles apart (0011). Staff UPDATE on leads is a column grant covering pipeline fields only. No API role inserts or deletes leads: public and manual leads are written by crm_ingest_lead() and erasure by crm_erase_*() as the service role, after assertCap, a live-recheck and a fail-closed audit row. ip_inet is never written. Content Creator and SEO get no lead access. Marking a lead as spam caps its retention at spam_days.'
- §3 Pillar 1, new bullet (CRM-1 and CRM-5): 'CRM (contacts, channels, notes, events, tasks, companies): the crm.* capabilities in both layers through one SQL helper per capability (app.role_*, kept equal to ROLE_CAPS by tests/authz/sqlHelpers.spec.ts). Every lead and CRM table holding personal data also carries a RESTRICTIVE live check, app.live_role(): the profile's role, is_active, locked_until and tenant, read at query time and required to equal the token's role. A demoted, deactivated or locked token reads nothing, even through PostgREST directly. Contact e-mail and phone are ciphertext with blind indexes. Leads and contacts are never in global search, the ⌘K palette, notifications to non-CRM roles, content backups (FORBIDDEN_BACKUP_TABLES) or logs. Erasing a person (crm.erase, Admin only) is audited before acting and deletes their leads (linked, or sharing an e-mail blind index; phone-only matches only when ticked), notes, tasks and contact in one transaction. Composite (tenant_id, id) foreign keys fence every CRM reference to the writer's tenant.'
- §3 Pillar 1, export-backup/export-csv bullet: append 'Sales never exports (no export.csv or export.backup). PII is decrypted only for leads.pii holders that also hold export.csv.' Also replace the prose name 'leads.sensitive' with 'leads.pii' here, in §10 and in architecture §4.7/§4.9/§9.8 so one vocabulary is used.
- §5 (CRM-1 relabels; CRM-3, CRM-5, CRM-8 and CRM-9 add rows; CRM-10 adds the Sales column): the table gains a Sales column, and the parser in tests/authz/matrix.spec.ts moves to 6 cells. Rows: 'Leads — view list / pipeline / assign / timeline' (leads.manage) ✅❌❌✅✅; 'Leads — contact details, budget, timeline, notes (PII, one lead at a time, audited)' (leads.pii) ✅❌❌✅✅; 'Leads / analytics — export CSV' ✅❌❌✅❌; 'CRM — contacts & companies (view, add, edit, notes, merge)' ✅❌❌❌✅; 'CRM — tasks' ✅❌❌❌✅; 'CRM — settings (pipeline stages, scoring, custom fields, response time, assignment)' ✅❌❌❌❌; 'Leads & contacts — erase a person's data (DSAR)' ✅❌❌❌❌. Every other row: Sales ❌. Canonical role model, add: 'Sales = works the CRM: leads (list, pipeline, assignment, notes, timeline, adding leads by hand), contacts and tasks. Reveals a lead's or contact's contact details and budget one record at a time, audited and rate-limited. NO content, NO settings (CRM settings included), NO exports or backups, NO job applications, NO logs/audit/site health, NO users, NO analytics, NO erasure, NO bulk PII.' Developer gets no crm.* (O2). Legend: Sales is default-deny on every row.
- §5 header sentence: replace 'Byte-for-byte identical to architecture.md §3.4, its ROLE_CAPS block, and the §9.3 authz test matrix' with 'Byte-for-byte identical to architecture.md §3.4 (same labels and cells, parsed by the same test) and to the SQL capability helpers (app.role_*, parsed from the migrations); a CI snapshot test fails on any drift. architecture §9.3 points at tests/authz/endpoints.spec.ts.' This fixes the claim that today is enforced only for this file.
- §7 Security non-negotiables, PII handling bullet: 'envelope-encrypt lead phone/email/budget/timeline and contact channels. The gate of record is the role-checked, per-record, audited (fail-closed), rate-limited decrypt path (leads.pii: Admin, Developer, Sales), with column grants, leads_safe (SECURITY INVOKER), the RESTRICTIVE live check and RLS as defence in depth.' Add a bullet: 'CRM data is operational, never content: never staged into the site-wide release, never in content backups, every write versioned and audited.'
- §8 Data model: replace 'Leads PII (budget/timeline/internal_notes/ip_inet) gated to Admin/Developer' with 'Leads PII (budget, timeline, the notes thread) gated to leads.pii.' Add a 'CRM (0030+)' bullet: lead_stages (tenant-editable labels, fixed tone palette, kind open/won/lost, one initial; leads.stage_id composite FK); spam is the system flag leads.is_spam, never a stage; lead_notes (append-only) and lead_events (written by triggers, not audit_log); crm_settings (singleton; messaging settings are a separate table later); crm_contacts with crm_contact_channels (ciphertext, blind indexes, one e-mail per tenant), crm_contact_notes and crm_contact_events; crm_tasks; crm_companies; merge by tombstone; one SQL helper per CRM capability (app.role_*); app.is_staff() = CMS staff (Sales is not staff); app.is_member() = any role, used only by audit_insert.
- §9 Targeted security regression tests, add: (i) CRM stale token: a demoted, deactivated or locked token reads zero rows of leads, lead_notes, lead_events and every crm_* table, through PostgREST directly; (j) reveal: a failed audit insert gives 403 and no plaintext, the 61st reveal in an hour gives 429, and list/board/summary/lookup responses never contain e-mail, phone, budget, timeline, notes or blind-index keys; (k) Sales negative matrix: Sales gets 403 on every non-CRM endpoint and zero rows on every is_staff() or Admin/Developer table, and its audit rows carry its own actor_id only; (l) erasure completeness: after an erase no row references the person's ids or e-mail blind indexes, and the erase is refused when the attempt audit cannot be written; (m) the role-matrix snapshot covers 5 roles across CLAUDE.md §5, architecture §3.4 and the SQL helpers; (n) spam retention: marking spam sets retention_delete_after to at most now()+spam_days, and clearing spam never extends it.
- §10: append to the Errors bullet 'beforeSend and log scrubbing also strip CRM notes, contact channel values and task titles.' Append to the Lead notifications bullet 'notify-lead recipients are the holders of leads.manage; field gating stays canSeeLeadPii.' Add: 'The CRM sends nothing in the core phase (no e-mail or WhatsApp). Outbound channels arrive with the Inbox/Campaigns phase and a §10 amendment.'
- §2 Phase-3 amendment list, add one line: 'Lead notes became their own table (lead_notes) because the notes cut through the leads row by capability (leads.pii versus leads.manage), the same row-level reasoning as site_integrations and entity_seo.'
- §3 Pillar 1: delete the false sentence 'leads_safe's GRANT is not to all authenticated' (it has been granted to all authenticated since 0002/0011; RLS through security_invoker is the control) as part of the CRM-1 rewrite.

## Owner items

- O1: Confirm Sales sees budget and timeline, one lead at a time, audited and rate-limited (recommended). If not, the design splits out leads.contact (e-mail/phone, with notes following it), encrypts the legacy plaintext timeline_band, and hides budget-derived score reasons from Sales.
- O2: Confirm Developer gets no crm.contacts, crm.tasks, crm.settings or crm.erase (recommended: technical role, mockup parity, least privilege). Also decide whether Developer keeps lead access long-term now that Sales exists; that would be a separate §5 change.
- O3: Backfill target for legacy 'done' leads: Lost (default; never invent a win) or Won. Moved leads are tagged in the timeline and a 'Was Done' filter finds them for re-triage.
- O4 (legal/DPO, KAN-22): approve privacy-notice changes, EN and AR, before CRM-5 and CRM-13 ship. Covers: contacts built from inquiries; notes and tasks; retention measured from the last activity (24 months, 'Expiring soon' 30 days before); attribution recorded with an inquiry and the consent dependency; backups keeping erased data up to 28 days; the DSAR answer within 30 days.
- O5: Approve the rate limits: contact-detail reveals at 60 per hour per user and 300 per hour per tenant; erasures at 20 per hour per user and 50 per hour per tenant.
- O6: Confirm erasure is Admin-only and immediate, and that phone-only matching leads are erased only when the Admin ticks them.
- O7: Later phase only, nothing now: choose the providers for outbound e-mail (Cloudflare Email Service or Resend) and WhatsApp (Cloud API), and accept the WhatsApp Business onboarding.
- O8 (ops): on staging, verify the pg_cron role bypasses RLS so app.run_retention really deletes. This applies to today's purge_leads too, which nothing has ever tested deleting rows.
- O9: Default assignment rule: Manual (recommended) or Round robin over a chosen pool once Sales users exist.
- O10: Sidebar Tasks badge counts MY overdue tasks (recommended) rather than everyone's (mockup).
- O11: Approve the seeded stages and tones: New/klein, Contacted/sky, Proposal sent/warn, Won/ok, Lost/gray. Also the tenant time zone Asia/Riyadh.
- O12: Confirm the deferrals the client will notice: consent toggles and unsubscribe, Files, Import CSV, Export and Segments, Suggested reply and Send, Inbox. They need the LATER phase (channels, consent design, public opt-ins) to be honest under PDPL.
- O13: Invite the first Sales users after CRM-10 ships, with display names set so assignees are readable.

## Open questions

- Should Sales see all leads and contacts (mockup, default) or only those assigned to them plus unassigned? A row-scoped policy is possible later through the role helpers.
- Is per-lead read state ('someone on the team has looked') enough, or does the team want per-user unread? Per-user needs a reads table, as the later Inbox will have.
- Merge: always keep the older record (mockup), or let the user choose the survivor? The default here is older, with a swap.
- Contact value and score are derived (sum of won lead values, highest lead score). Does the client also want a manually editable contact value?
- Should 'Past client' be automatic (no won lead in 6 months), or stay manual in the core?
- Should a note's author be able to edit it for a short window, or should notes stay append-only (default) with Admin deletion through crm.erase?
- Should the dashboard give Sales CRM widgets only (Leads waiting, My tasks, Pipeline)? This depends on the dashboard architect's widget framework.
- Does the shell IA keep Job applications next to Leads, or move it out of the CRM group? It is Admin-only HR data, not CRM.

## Deviations from the prototype

- No Budget column in the leads list and no budget on board cards or the dashboard: budget is encrypted PII, revealed one lead at a time (§3 Pillar 1). Won cards show value_sar, which is not PII.
- E-mail and phone are masked everywhere (list subtitles, inbox panel, merge pairs, typeahead, contact details) behind 'Reveal contact details (this access is logged)'. The reveal is audited fail-closed and rate-limited. mailto, tel and wa.me links appear only after a reveal.
- No client-side CSV. 'Export CSV' links to the server export with the current filters and shows only for export.csv holders (Admin, Developer), never for Sales. Note bodies are not exported.
- Leads and contacts are never in the ⌘K palette or global search (globalSearch.ts exclusion kept); the CRM keeps its own gated search.
- No bulk Delete and no per-lead or per-contact Delete for Sales: they become 'Mark as spam' (30-day retention) and an Admin-only, audited 'Erase' (DSAR) that removes the person's leads too. The mockup left lead PII behind.
- Statuses become editable pipeline stages with a fixed palette of six named tones. There is no free colour picker or hex input, because free colours need inline style, which the CSP blocks. Spam is a system flag, not a stage.
- Every board card has a keyboard and screen-reader 'Move to…' control with announcements; drag-and-drop is optional (WCAG 2.1.1 / 2.5.7).
- No keystroke autosave ('Changes save as you type'): discrete controls apply at once as one versioned PATCH each, and forms have an explicit Save. Optimistic locking and one audit row per mutation (§3 Pillar 4).
- Search for e-mail or phone matches only a complete value (blind index); partial matching applies only to name, company and message.
- Average response time, conversion and deltas are computed from real data, with 'Not enough data yet' when it is thin. The mockup's hard-coded '3h 40m −12%' and fake deltas are dropped.
- Lead score comes from a fixed set of signals with editable points (not free-text rules), is recomputed on the server, and shows reasons only to PII holders.
- Retention: 'Keep contacts for 2/3/5 years… flagged for review, not deleted silently' becomes one horizon of at most 24 months after the last activity, shown under 'Expiring soon' for 30 days, then deleted (PDPL; legal sign-off pending).
- Consent toggles, 'Mark unsubscribed / Resubscribe', the Consent column and the Consent card are not built in the core. Consent belongs with the campaigns phase and the public form's versioned opt-ins; the existing checkbox is consent to reply, not marketing consent.
- Lead detail 'Suggested reply', 'Send email' and the Inbox 'Send' are not built (no outbound channel). They become mailto and wa.me links after a reveal plus 'Log contact'.
- Contact 'Files' card is not built. Files will later use a private bucket with audited downloads, never the public media bucket.
- Import CSV, Export, Segments, 'Add to campaign' and the campaign or segment links on Contacts are hidden (LATER phase).
- Inbox, Campaigns, Automations, Templates, CRM reports, Export & audiences and the Get-connected banners are absent from the sidebar and from the CRM settings cards (Email sending, WhatsApp Business, Sending rules).
- Tasks 'Send' becomes 'Open contact'. The due time is chosen (default 10:00) instead of fixed. All time arithmetic uses the tenant time zone (Asia/Riyadh) on the server, not the browser.
- The .ics file contains only the task title and an admin link: no contact name or note (data minimisation). PRODID and UID come from site_profile and the site origin, never a hard-coded brand.
- The sidebar Tasks badge counts my overdue tasks, not everyone's. The Leads badge counts new (initial-stage, non-spam) leads.
- Read and star are per lead (team-wide), as in the mockup. Unread is not offered per user in the core.
- Add contact: no default city ('Jeddah') or country, and no fixed starting score of 40. Source is one fixed list everywhere; the Details card no longer takes free text for it.
- Add lead manually and Add contact need a name and an e-mail or phone (the mockup required only a name). A duplicate e-mail links to the existing person instead of creating a second one.
- Merge shows reasons ('same phone', 'same company domain and similar name') rather than the contact values, and adds 'Not a duplicate' (dismiss). The kept record is the older one, with a swap option.
- Companies get a way to be created ('Create company from this name'); the mockup had none.
- Roles: the mockup's Owner, Editor, Account manager, Marketer, editable role permissions, per-user grant/deny overrides and 'View as' are not built. Developer gets no CRM contacts or tasks (the mockup also gives developer none) but keeps leads.
- Page titles and URLs carry no person names or e-mails (generic <title>, ids in URLs, search text kept out of the URL).
- CRM never shows the site-wide unpublished-changes bar and is never part of a release, preview or rollback: CRM data is operational.
