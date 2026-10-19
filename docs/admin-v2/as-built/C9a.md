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
  postconditions for both grant regimes; a TODO where the help guide's put goes once H11 lands.
- **Routes.** `GET` and `PUT /api/admin/crm/settings`, `PUT /api/admin/crm/stages`
  (`crm.settings`), audited `crm.settings.update` and `crm.stages.update`.
- **Screen.** `/admin/crm/settings` in Settings ("CRM settings"), an island in the
  `admin-screens` group, four cards each with its own Save.
- **Tests.** pgTAP `crm_settings.test.sql` (six principals, a stale token, the stage rules,
  re-scoring, round robin), the pgTAP files whose "staff cannot write this yet" lines flip,
  vitest for the schemas, the routes, the tone palette's contrast, the authz cases, the matrix
  and helper specs, the audit labels and the help guide's claims.
