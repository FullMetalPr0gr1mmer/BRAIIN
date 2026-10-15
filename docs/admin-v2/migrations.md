# Migration ledger

The bookkeeping for every migration the Admin v2 program ships: what production has applied,
the numbers reserved for slices that have not merged, the rules that keep parallel lanes from
colliding, and how a migration reaches production. The standard is CLAUDE.md §8 ("Migrations
forward-only, expand/contract"), enforced by `scripts/check-migrations.mjs`; this file is how
the program applies it. No URL, credential or project reference belongs here.

## Applied

Production has applied 0001 to 0038, 0041, 0044, 0045, 0046 and 0048, the same files `main`
holds (0039, 0040, 0042, 0043 and 0047 were released unused; gaps are allowed).

| Migration | What | PR |
|---|---|---|
| 0001 to 0029 | Everything before the Admin v2 program: the launch schema, the Phase 3 admin, UI v2, Round 2 and Join | up to #28 |
| 0030 | `0030_leads_grant_layer.sql`: staff UPDATE on `leads` narrowed to `status` and `internal_notes`, table-wide writes revoked, the service role's grants stated (H2) | #30 |
| 0031 | `0031_audit_chain_serialize.sql`: the audit hash chain takes a per-tenant lock, so concurrent inserts cannot fork it (H5) | #36 |
| 0032 | `0032_content_versions_insert.sql`: history rows are written by the snapshot trigger only (H6) | #42 |
| 0033 | `0033_leads_pii_db_layer.sql`: staff tokens read only the safe lead columns, behind a live check on every lead row (C1a-1). A contraction: applied after #43's deploy was live | #43 |
| 0034 | `0034_crm_leads_pipeline.sql`: the leads pipeline, spam horizon, timeline and notes thread (C1a-2) | #45 |
| 0035 | `0035_crm_ingest.sql`: how a lead arrives: the ingest RPC, blind indexes, the score (C1b) | #45 (from #46) |
| 0036 | `0036_crm_leads_queries.sql`: reading the pipeline: list, board, KPIs, people (C2a) | #45 (from #47) |
| 0037 | `0037_partition_rls_and_read_only_grants.sql`: RLS on every telemetry partition; staff hold SELECT only on the eight tables they only read, plus the users screen's UPDATE on `profiles.role`, `is_active` and `display_name` (H8) | #51 |
| 0038 | `0038_release_ledger.sql`: the release ledger schema: ledger tables, the staged-entity registry, the protected flag table, snapshot coverage (all but `team_members`, which waits on O-12) (expand, inert) (R1) | #56 |
| 0041 | `0041_crm_leads_write.sql`: the leads write API: the `crm.erase` helper, the pipeline's assignee, value, star, read, tags and logged-contact columns with their staff column grant, and the bulk, erase, note-delete and note-count RPCs (`crm_ingest_lead` restated for manual leads) (C3) | #57 |
| 0044 | `0044_personal_layer.sql`: the personal layer: preferences (`admin_user_prefs`, keyed to its profile by `(tenant_id, user_id)`), the people directory (`app.staff_directory()`, `public.staff_directory`, `crm_people` over it), the display-name rule for every writer (`app.display_name_ok`, the `profiles_display_name_rule` trigger), renaming yourself (`update_my_profile`), the environment pill (`admin_environment`). Renumbered from 0039 by the Wave 1 plan. Applies after 0041: the preferences key rests on 0041's `profiles_tenant_id_id` (F8) | #58 |
| 0045 | media uploads: the public media bucket (refused if a different `media` bucket exists) and its policies, the `media_assets` provider widening and shape check, one row per uploaded file (a unique key index), `display_name`, `media_assets`' grants stated, the storage meter and the orphan lookup with its floor (`0045_media_uploads.sql`) (U3) | #59 |
| 0046 | `0046_help_centre.sql`: the help centre: `help_articles` (typed blocks, never HTML; staff read their tenant's guides, nothing writes but the migrations and the service role), `help_search` (a contains search, Arabic folded with `app.normalize_ar_q` as §8's contains searches are; up to 100 guides, filtered by role in the Worker), the guides (`app.help_article_set()`) and their seed into every tenant and, by a trigger on `tenants`, each new one. Renumbered from 0042 (U16) | #62 |
| 0048 | `0048_lead_notify_trigger.sql`: the lead-notification trigger restored and hardened: pg_net created where missing; `app.tg_notify_lead()` re-created SECURITY DEFINER with an empty search_path, posting to the https URL in Vault (`notify_lead_url`, no longer `site_settings`) with a timestamp and an HMAC signature instead of the secret, and no catchable error failing an insert (a lead it cannot announce is a WARNING and a `system_logs` row); `leads_notify` created on every database (0010 created it only where pg_net already was, and production's was not); `public.lead_notify_misses()` for the daily cron (`0048_lead_notify_trigger.sql`) (H9) | #63 |

Each slice's file under [as-built/](as-built/) has the detail.

## Reserved

Wave 2's migrations (with hotfix H10) and Wave 1's held one (C13) are reserved below; the next
free number after them is **0060**. Before a wave's slices branch, each migration the wave plans gets a row here,
numbered in the wave's planned merge order. The slice's own PR moves its row to "Applied" once
production has applied the migration, before the PR merges (Pushing to production, step 5), so
the row is true when the PR lands and nothing here is edited after a merge.

| Number | Slice | What | Wave |
|---|---|---|---|
| 0039 | (released) | unused: C3 (0041) was ready before F8 and U3 were built, so F8 and U3 moved above the wave (gaps are allowed) | 1 |
| 0040 | (released) | unused, as 0039 | 1 |
| 0042 | (released) | unused: F8 (0044) and U3 (0045) merged first, so U16 moved to 0046 | 1 |
| 0043 | (released) | unused, as 0042: C13 moved to 0047 | 1 |
| 0047 | (released) | unused: U16 (0046) and then H9 (0048) merge before C13, and once 0048 is on `main` a 0047 would sort below its highest, so C13 moved to 0049 | 1 |
| 0049 | (released) | unused: H10 (0050) merges before C13, and once 0050 is on `main` a 0049 would sort below its highest (rule 1), so C13 moved to 0059 | 1 |
| 0050 | H10 | live profile writes and the audit actor binding: RESTRICTIVE live policies on every staff write to `profiles`, `app.role_manages_users`, the `audit_log_actor` trigger, `audit_log`'s grants stated (no TRUNCATE for any API role) | 2 |
| 0051 | R4 | `apply_release` and capture (inert while `release_tenants` is empty) | 2 |
| 0052 | U2 | stats and health, `rollup_daily_vitals` | 2 |
| 0053 | U1 | the dashboard: presets and team notes | 2 |
| 0054 | U13 | the activity log v2: the live read on `audit_log`, `audit_people` (the actor binding is H10's) | 2 |
| 0055 | U12a | users v2 and the session posture: the live read on `profiles`, session revocation on a role change, owner protection, security settings | 2 |
| 0056 | U12b | invites: the help guide | 2 |
| 0057 | U14a | page visibility | 2 |
| 0058 | U14b | the page password | 2 |
| 0059 | C13 | lead attribution capture (built, held for the privacy notice, O-11); moved from 0047, then from 0049 | 1 |

## Rules

1. **Numbers only go up.** A new migration numbers strictly above the highest file on `main`,
   one file per number, named `NNNN_snake_case.sql`. A file already on `main` is never edited,
   renamed or deleted: production has applied it, so a change is a new migration.
   `scripts/check-migrations.mjs` (CI's `migrations` job) enforces all of this against the PR's
   base: `node scripts/check-migrations.mjs origin/main`.
2. **Reserve per wave.** Numbers are handed out here per wave, in the wave's planned merge
   order, before its slices branch, so two lanes never pick the same number.
3. **Renumber before merging if the order changes.** A reservation is a plan. If PRs merge in a
   different order, the later one renumbers its file, and every reference to the number,
   before it merges, so it still sorts above `main`; `scripts/renumber-migration.mjs` (Wave 0,
   W0-b) is the helper. The script leaves the Reserved rows here as they are (they are lines
   from `main`), so the slice moves its own row by hand, and it never takes a number reserved
   here for another slice: it takes the lowest number above `main`'s highest that no other
   slice holds (the script lists this file's lines that name the old number, and skips any
   number reserved here for another slice, printing which slice holds it). Once a file is on `main`, its number is fixed.
4. **`ALTER TYPE app_role ADD VALUE 'sales'` sits alone in its file** (C10a's first
   migration). A new enum value cannot be used in the transaction that adds it (55P04), so
   every use of `sales` goes in a later file.
5. **Expand: apply, then merge.** A migration that only adds is applied to production before
   its PR merges, so the deployed code never expects something production lacks.
6. **A contraction ships as two PRs once #41's deploy guard is on.** A contraction takes away
   something the deployed code still uses: a revoked grant, a dropped column. The guard refuses
   a deploy whose checkout holds a migration production lacks, so code and contraction cannot
   share a PR: first the code that stops using it (merge, deploy), then the migration alone
   (apply, merge). Before the guard, 0033 shipped code first inside #43. A contraction also
   moves the Worker rollback floor (launch runbook §10).

## Pushing to production

Process only: the database URL and every credential stay with the operator.

1. **Order.** `supabase db push` applies every pending migration in the checkout, so push from
   the PR's own branch after `main` has been merged into it: the checkout must hold every
   earlier migration, in order.
2. **Dry run.** Run the push with `--dry-run` first. It must list exactly the files this PR
   adds, nothing more and nothing less; anything else means the checkout or production is not
   where it should be, so stop. (On 2026-10-05 a dry run from the CRM tip listed 0033 to 0036
   without 0031 and 0032; pushing from there would have broken the order.)
3. **Apply.** The same push without `--dry-run`. A migration's postconditions raise when it
   does not hold, and that migration is then not applied.
4. **Read back.** `migration list` shows the new version as applied. Then check the
   migration's effect read-only; for 0037: every partition RLS enabled and forced, no staff
   table-level write privilege on the eight tables and no column-level one but UPDATE on
   `profiles.role`, `is_active` and `display_name` (the users screen's, which must stay), no
   write policy on `tenants`.
5. **Record.** On the PR's branch, move its row from "Reserved" to "Applied" and raise the
   range in the sentence above that table. The PR already carries the slice's as-built file
   and its line in the README's index, so nothing is left to edit after the merge.
6. **Merge** (for an expand migration; a contraction's code PR has merged and deployed before
   step 1, rule 6).
