# C9a: CRM settings for leads

- **Lane:** CRM
- **Design:** [crm.md](../crm.md) CRM-9 (the leads half), §4.1 (stages), §4.7 (`crm_settings`),
  §6.3 (scoring), §9 (Settings routes), §11 screen 11; the approved plan B2 ("C9a: the CRM
  settings that are lead configuration only"), B6 (O-9 manual assignment, O-10 the mockup's
  stages and tones, Asia/Riyadh), B7.5 (the time zone moves to `site_profile`, so it is not
  edited here)
- **PR:** the `feat/c9a-crm-settings` branch (its number is given at review)
- **Migration:** built as 0091 (`0091_crm_settings.sql`), a placeholder: its number is assigned
  at merge with `scripts/renumber-migration.mjs`. Expand only: push, then merge.

## Plan (written before the build)

- **Scope.** Pipeline stages (label, tone from the closed palette, kind, order; add, delete an
  empty stage; the initial stage locked), lead scoring (the closed signals, 0 to 50 points, the
  score capped at 100, every lead re-scored when the points change), response time (SLA hours)
  and assignment (Manual, Round robin over a pool, Always to one person), and the new
  capability `crm.settings` (Admin). Not here: custom fields (C9b, with contacts), contact
  stages (contacts), Data & privacy (retention is `settings.general`'s, erasure of a person is
  contacts'), the messaging cards (L6), the time zone (B7.5).
- **Migration.** `app.role_crm_settings`; `crm_settings` gains `assignment_rule`,
  `assignment_pool`, `assignment_fixed_to`, `rr_cursor`; staff UPDATE on the configuration
  columns for `crm.settings` holders (column grant, policy, RESTRICTIVE live check), the version
  and stamps moving only with the configuration; a definer trigger re-scores the tenant's leads
  when the points change and checks the assignees; `lead_stages` gains column INSERT/UPDATE and
  DELETE for `crm.settings` holders (never `key`, `is_initial`, the tenant); `save_lead_stages`
  (INVOKER) applies a whole pipeline against the set as loaded; `lead_stage_counts` (INVOKER);
  the assignment step in `crm_ingest_lead` through a definer `app.crm_pick_assignee`;
  postconditions for both grant regimes; the help guide's put (H11's `app.put_help_guide`).
- **Routes.** `GET` and `PUT /api/admin/crm/settings`, `PUT /api/admin/crm/stages`
  (`crm.settings`), audited `crm.settings.update` and `crm.stages.update`.
- **Screen.** `/admin/crm/settings` in Settings ("CRM settings"), an island in the
  `admin-screens` group, four cards each with its own Save.
- **Tests.** pgTAP `crm_settings.test.sql` (six principals, a stale token, the stage rules,
  re-scoring, round robin), the pgTAP files whose "staff cannot write this yet" lines flip,
  vitest for the schemas, the routes, the tone palette's contrast, the authz cases, the matrix
  and helper specs, the audit labels and the help guide's claims.

## What was built

- **`crm.settings`**, Admin only, in `ROLE_CAPS`, CLAUDE.md §5 ("CRM settings — pipeline
  stages, scoring, response time, assignment"), architecture §3.4 (the row and its `ROLE_CAPS`
  block) and §9.3 (34 capabilities), its SQL helper `app.role_crm_settings` with its
  `HELPER_CAPABILITY` line, `CAP_LABELS` and the Users screen's read-only matrix (Leads group).
  Developer gets no CRM configuration (owner item O-7).
- **Migration 0091** (`0091_crm_settings.sql`, numbered at merge):
  - `crm_settings` gains `assignment_rule` (manual, round_robin, fixed; manual by default, O-9),
    `assignment_pool` (`app.crm_pool_ok`: one dimension, at most 20, no blanks, each once),
    `assignment_fixed_to` (composite key to `profiles (tenant_id, id)`, `ON DELETE SET NULL
    (assignment_fixed_to)`) and `rr_cursor`.
  - Its `updated_at`, actor and version triggers fire only for the configuration columns
    (`UPDATE OF …`), so round robin moving the cursor at arrival never makes the screen's next
    save a 409.
  - `app.tg_crm_settings_assignees` (definer, BEFORE): each person ADDED to the pool and the one
    person must be an active lead worker of the tenant; a rule set to fixed needs the person, to
    round robin someone in the pool (checked when the rule is set, so a profile deleted later,
    whose key empties the person, is not refused).
  - `app.tg_crm_settings_rescore` (definer, AFTER UPDATE OF scoring): every lead of the tenant
    whose score moves gets `app.lead_score(score_signals, new points)`. A score is derived
    (`app.tg_lead_pipeline`'s `c_derived`), so no lead's version, editor or timeline moves.
  - Grants and policies: staff SELECT on `crm_settings`, UPDATE of `scoring`, `sla_hours` and
    the three assignment columns; `crm_settings_read` (lead workers or `crm.settings`),
    `crm_settings_write` and the RESTRICTIVE `crm_settings_write_live`. On `lead_stages`: SELECT
    and DELETE, INSERT of `label, label_ar, tone, kind, sort_order` (never the key: the BEFORE
    INSERT trigger `lead_stages_key` sets it from the label plus a random suffix, so no writer,
    door or direct, reuses a deleted stage's key, which old timeline events name), UPDATE of
    `label, label_ar, tone, kind, sort_order`; insert, update and delete policies for `crm.settings`
    (delete never the initial stage), each with its own RESTRICTIVE live policy. The service
    role's grants are stated.
  - `public.save_lead_stages(p_tenant, p_known, p_stages)` and
    `public.lead_stage_counts(p_tenant)` (SECURITY INVOKER, `authenticated` only);
    `app.crm_pick_assignee` (definer, service role only); `public.crm_ingest_lead` restated with
    the assignment step (allow-list unchanged).
  - Postconditions for both grant regimes: RLS forced; PUBLIC and anon hold nothing, table-wide
    or by column; the exact column sets; the exact policy sets, tenant predicate first, four live
    checks; who executes each function; the definers' owner bypasses RLS; every tenant manual.
  - Read-back for production: the scratchpad's `readback_c9a.sql` (replace `'0091'` with the
    number the file lands as).
- **Routes:** `GET`/`PUT /api/admin/crm/settings`, `PUT /api/admin/crm/stages`
  (`crm.settings`); the read is four calls (the row, the stages, the counts, `crm_people`).
  `src/lib/crm/settings.ts` holds the reads, the writes and their error mapping: a stale save is
  a 409; a stage that holds leads is a 409 `in-use` saying "Proposal sent holds 3 leads. Move
  its 3 leads first." (23503 from the door or the foreign key on PostgreSQL 15 to 17;
  23001 if PostgreSQL 18's foreign key refuses first, as seen in PGlite); a refused assignee is a 422 on its field; a malformed pipeline a 422 in plain words;
  the database's own words are never echoed. Audit rows carry the cards' field names
  (`crm.settings.update`) and counts (`crm.stages.update`), never values.
- **Screen:** `/admin/crm/settings`, the Settings group's "CRM settings" link (icon `kanban`),
  `AdminCrmSettings` in the `admin-screens` group (listed in `ADMIN_EDITOR_ISLAND_NAMES` and
  `ADMIN_EDITOR_SCREEN_DIRS` so its code rides only with that group, not on every screen in
  `admin-ui`), `public/styles/admin/crm-settings.css`. Three cards, each with its own Save:
  Pipeline stages (label; the tone as real radios whose labels are the badges, chosen by name;
  Counts as Open, Won or Lost; the leads it holds; Move up, Move down, Remove; Add stage), Lead
  scoring (the seven live signals, 0 to 50 each, the highest possible score shown, capped at
  100), and Response time and assignment (hours; Manual, Round robin with a checklist of the
  people who work leads, or Always to one person). The two settings cards share the row's
  version without resetting each other's unsaved fields.
- **Help:** the guide `crm-settings` (sort_order 75, three minutes, EN and AR), put by 0091
  with `select app.put_help_guide($guide$ … $guide$::jsonb, 0);` (H11, a new guide, so revision
  0), and its `PAGE_GUIDES` entry. 75 is the free place after the leads guide (70), taken first
  in merge order (corrections rule 2): C10a's sales guide (0097) merges after and takes another.
  A postcondition, a pgTAP row and the read-back check the guide reaches the catalog and every
  tenant; `tests/lib/helpCentre.spec.ts` reads it from the migration like every other guide and
  holds it to the screen (the guide-file staging used before H11 merged is gone).
- **Tests:** pgTAP `supabase/tests/crm_settings.test.sql` (`plan(94)`); one assertion each in
  `crm_ingest.test.sql` (47) and `rls_lead_pipeline.test.sql` (71) that said "staff cannot
  write this yet" now says what stays closed (the time zone; a key, a tenant);
  `tests/lib/crmSettings.spec.ts`; three authz cases; the matrix, helper, sidebar,
  locked-screen, stylesheet and audit-label pins.

## Departures from the design, and why

- **The pipeline's version is the set as loaded, not `crm_settings.version`.** crm.md has the
  stages PUT carry the settings row's version. Then saving the stages would 409 the scoring
  card and the other way round. The door instead takes `[{id, version}]` of every stage the
  screen loaded and refuses (40001) when the set or any stage changed: a stage someone else
  added is never deleted by a save that did not know it.
- **A stage that holds leads keeps its kind** (not in crm.md). Turning an open stage that holds
  leads into Won would make them count as won with no `won_at`, and the KPIs read both. The
  screen says so, the door refuses it with the count, as for a delete, and a definer trigger
  (`lead_stages_kind_fixed`, 23503) holds it for a direct write through the column grant too
  (found in the self-review: the door alone left PostgREST open to an Admin token).
- **The assignees are checked by a trigger, the pool only for people added.** A member switched
  off later must not block a save that leaves them in; arrival skips them, and the screen drops
  people no longer offered when it saves.
- **Re-scoring is a trigger, not `app.recompute_lead_scores()` with its own live check.** Any
  path that changes the points re-scores, and only a live `crm.settings` holder (or the service
  role) can change them, which the column grant, the policy and the live check already decide.
- **Assignment applies to every lead that arrives without an assignee, a manual add
  included.** The ingest allow-list has no assignee, and "always to one person" means every new
  lead.
- **No `assigned` event at arrival.** `app.tg_lead_timeline` writes `created` only on insert;
  restating it whole for one event was not worth the risk here. The lead shows its assignee.
- **Not built here:** custom fields (C9b, with contacts), contact stages (contacts), Data &
  privacy (retention is `settings.general`'s General settings; erasing a person is contacts'),
  the messaging cards (L6), the time zone (B7.5), the Arabic stage label (`label_ar` is kept as
  it is; the Arabic admin is L7). `service_page`'s points are not offered until attribution
  (C13) sets that signal; they are kept as they are.
- **Copy:** the prototype's "Colour" picker is named swatches (the TDD row, "Fixed tones
  instead of hex"); "Drag to reorder" is Move up / Move down (a list of at most ten).

## Self-review

- Security: every write is two layers (`assertCap('crm.settings')` and RLS with a live check);
  the door refuses a stale or wrong-tenant token itself, since a refused UPDATE through RLS says
  nothing; no API role can make a second initial stage, name or rename a key or pick a tenant
  (column grants); the definers have empty search paths and are run by no API role; audit rows carry
  field names and counts only.
- Residual, accepted (see Decisions recorded): the scoring side channel.

## Decisions recorded

- **The scoring side channel is accepted.** The points are Admin's (`crm.settings`), and an
  Admin can weight one budget signal alone (for example `budget_200k_plus` = 50, every other
  signal 0), so every lead's score then reveals that budget band to whoever reads the score. It
  is accepted because every lead worker today (Admin and Developer) already holds `leads.pii`
  and can read the budget itself, and every points change is audited (`crm.settings.update`).
  It is noted for any future role that works leads without holding `leads.pii` for every lead
  (C10a's Sales holds it one lead at a time): before such a role sees scores in bulk, either hide
  the score from it or fence the points (for example a floor on the other signals' weights).
  CLAUDE.md §3's lead-PII bullet says the same.
- **Manual adds are assigned by the rule too (the default kept).** Under round robin or
  "Always to one person", a lead added by hand gets the rule's assignee like a web lead, because
  `crm_ingest_lead`'s allow-list carries no assignee and the rule reads as "every new lead". The
  alternative, a manual add going to the person who added it, was considered and not taken; it
  would need an assignee in the allow-list (a later slice, if the owner asks).

## Follow-ups

- `crm_settings.timezone` moves to `site_profile.timezone` with U9 (B7.5) and is dropped in
  C14.
- PostgreSQL 18 (seen in the PGlite replay, `server_version_num` 180003) reports a RESTRICT
  foreign key as 23001, not 23503, so `rls_lead_pipeline.test.sql`'s 23503 fails there only. CI
  (15.8) and production (17.6) raise 23503; the Worker maps both, ready for an upgrade.
