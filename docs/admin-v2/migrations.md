# Migration ledger

The bookkeeping for every migration the Admin v2 program ships: what production has applied,
the numbers reserved for slices that have not merged, the rules that keep parallel lanes from
colliding, and how a migration reaches production. The standard is CLAUDE.md §8 ("Migrations
forward-only, expand/contract"), enforced by `scripts/check-migrations.mjs`; this file is how
the program applies it. No URL, credential or project reference belongs here.

## Applied

Production has applied 0001 to 0038, 0041, 0044, 0045, 0046, 0048, 0050, 0051, 0052, 0054, 0055,
0056, 0057, 0060, 0061, 0062, 0063, 0064, 0065, 0066, 0067, 0068 and 0069, the files `main` holds once #88 merges (0039, 0040, 0042, 0043,
0047, 0049, 0053 and 0058 were released unused; gaps are allowed).

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
| 0050 | `0050_live_profiles_audit_actor.sql`: live profile writes and the audit actor binding: RESTRICTIVE live policies on every staff write to `profiles`, `app.role_manages_users`, the `audit_log_actor` trigger, `audit_log`'s grants stated (no TRUNCATE for any API role) (H10) | #66 |
| 0051 | `0051_release_apply.sql`: `apply_release` and capture (inert while `release_tenants` is empty) (R4) | #69 |
| 0052 | `0052_stats_health_rollups.sql`: stats and health: `rollup_daily_vitals`, the invoker readers, whole-day page views (`app.rollup_pageviews` restated), the help set restated (U2). Applied before #72 merged | #72 |
| 0054 | `0054_activity_log.sql`: the activity log v2: `app.role_views_audit`, the RESTRICTIVE live read on `audit_log` (`audit_log_live_read`), the person and day filter indexes, `public.audit_people` (the people directory's audit door, former members included), the help set restated from 0052's with the activity log's guide text (the actor binding is H10's, 0050) (U13). Applied before #71 merges | #71 |
| 0055 | `0055_users_v2.sql`: users v2 and the session posture: `profiles_revoke_sessions` (every session of a person whose role, activity or tenant changes is deleted; the postconditions refuse the push unless the owner can DELETE `auth.sessions`/`auth.refresh_tokens`), the RESTRICTIVE live read on `profiles` (`profiles_live_read`), the account owner (`profiles.is_owner`, `profiles_one_owner`, `app.tg_profiles_owner_guard`, `public.transfer_ownership`), `admin_security_settings`, `public.staff_accounts`, the help set restated from 0054's with the roles guide rewritten (U12a). Applied before #70 merges | #70 |
| 0056 | `0056_invites.sql`: the invites guide, `inviting-people`, added to the help set restated from 0055's, and every tenant re-seeded; no schema change (U12b). Applied before #73 merges | #73 |
| 0057 | `0057_page_visibility.sql`: page visibility, without the password mode: `public.page_visibility` (one row per CMS page or template: public, hidden with an optional redirect, or link-only, with a hide-from/show-on window; RLS ENABLE + FORCE, CMS roles read, Admin and Developer write through the JWT role and a RESTRICTIVE live check, no DELETE, no anon access; the homepage is always public), `pages_tenant_id_id`, `app.role_manages_visibility`, the `pages_route_slug_fixed` trigger, its release-registry row (immediate until R14), and the help set restated from 0056's with `page-visibility` added (U14a). Applied before #74 merges | #74 |
| 0060 | `0060_dashboard_layer.sql`: the dashboard layer: `admin_role_defaults` (a role's preset layout and quick actions, written by `app.role_manages_users(app.live_role())`), `admin_user_prefs.dashboard`, `team_notes` with `public.save_team_notes()` and `app.expire_team_notes()` (blanked 180 days after the last edit, daily by pg_cron `team-notes-retention`), and the help set restated from 0057's with `your-dashboard` added and `/admin` taken off `finding-your-way` (U1). Applied before #75 merges | #75 |
| 0061 | `0061_page_password.sql`: the page password: `page_passwords`, `set_page_password`, `page_password_check`, the `page_sections` fence, `page_sections_unlocked` and `page_media_unlocked`; renumbered from the reserved 0058, which would sort below `main`’s highest once U1’s 0060 merged (rule 1). Applied before #78 merges | #78 |
| 0062 | `0062_release_drafts_write.sql`: staff draft writes on `content_drafts` (grants stated), RESTRICTIVE live, releases-on and singleton-key policies, `public.releases_enabled`, `public.write_drafts` (the one draft writer), `app.draft_key_ok` (expand, inert until R14) (R3a). Applied before #80 merges | #80 |
| 0063 | `0063_crm_leads_readers_v2.sql`: `app.lead_filter` and `leads_list`, `leads_board`, `lead_summary` restated with assignee (`me` in SQL), star, unread, source, channel, discipline, a starred-first sort, the SLA flag and the won value (0036's keys unchanged); `public.lead_neighbours`; the shared predicate set and order `app.leads_matching` and the one SLA rule `app.lead_over_sla` (C4a). Applied before #79 merges | #79 |
| 0064 | `0064_media_library.sql`: `public.media_library` (the library's search and paging: SECURITY INVOKER, staff only, the tenant named and checked, Arabic folded, `%` and `_` escaped), the help set restated with the media guide (U4; the help set restated from 0061's). Applied before #82 merges | #82 |
| 0065 | `0065_help_leads_v2.sql`: the help set restated with `working-with-leads` rewritten for the leads screens (C4b; the help set restated from 0064's). Applied before #85 merged | #85 |
| 0066 | `0066_release_guard.sql`: `<table>__release_guard` on every registry table and both case-study link tables (no depth exemption), system items and link-set capture (the sets kept per statement in `app.release_link_pending`), `media_usage` v4 (pending changes), `dashboard_attention` v4, `app.publish_scheduled()` skips tenants with releases on, TRUNCATE closed on guarded tables (expand, inert) (R5). Applied before #84 merges | #84 |
| 0067 | `0067_health_probes.sql`: `health_probes` (service role writes, Admin and Developer read), its stamps trigger, the help set restated with the site health guide (from 0065's) (G2). Applied before #86 merges | #86 |
| 0068 | `0068_help_leads_board.sql`: the help set restated with the Pipeline board's line in `working-with-leads` (the board was carved out of C4b by size; the help set restated from G2's 0067). C4c merged after G2 and took 0068, so every later Wave 3 reservation moved up by one (2026-10-18) (C4c). Applied before C4c's PR merges | C4c's PR |
| 0069 | `0069_help_catalog.sql`: `app.help_guide_catalog` (one row per guide; RLS forced, no policy, no API-role privilege), `app.help_article_set()` rendering it (byte-identical to the set it replaced, by an md5 postcondition), `app.put_help_guide(jsonb, revision)` and `app.drop_help_guide(slug, revision)` with a revision guard (55000) (H11). Applied before #88 merges | #88 |

Each slice's file under [as-built/](as-built/) has the detail.

## Reserved

Since 2026-10-18 (owner decision) **migration numbers are assigned at merge time**, not reserved: a
slice builds with the next free number on `main` when it starts and is renumbered with
`node scripts/renumber-migration.mjs` right before its merge, so a change of merge order costs
nothing. The rows below are the released numbers and C13 (held), kept for the record; the slices
in flight are listed after the table without numbers. A slice's PR adds its own row to
"Applied" once production has applied it, before the PR merges (Pushing to production, step 5).

| Number | Slice | What | Wave |
|---|---|---|---|
| 0039 | (released) | unused: C3 (0041) was ready before F8 and U3 were built, so F8 and U3 moved above the wave (gaps are allowed) | 1 |
| 0040 | (released) | unused, as 0039 | 1 |
| 0042 | (released) | unused: F8 (0044) and U3 (0045) merged first, so U16 moved to 0046 | 1 |
| 0043 | (released) | unused, as 0042: C13 moved to 0047 | 1 |
| 0047 | (released) | unused: U16 (0046) and then H9 (0048) merge before C13, and once 0048 is on `main` a 0047 would sort below its highest, so C13 moved to 0049 | 1 |
| 0049 | (released) | unused: H10 (0050) merges before C13, and once 0050 is on `main` a 0049 would sort below its highest (rule 1), so C13 moved to 0059 | 1 |
| 0053 | (released) | unused: U13 (0054) merged before U1, and once 0054 is on `main` a 0053 would sort below its highest (rule 1), so U1 moved to 0060, the lowest number above `main` that no other slice holds | 2 |
| 0058 | (released) | unused: U1 (0060) merged before U14b, and once 0060 is on `main` a 0058 would sort below its highest (rule 1), so U14b moved to 0061 | 2 |
| 0059 | C13 | lead attribution capture (built, held for the privacy notice, O-11); moved from 0047, then from 0049. Below Wave 3's numbers: when released it renumbers to the lowest free number above `main`'s highest (rule 3), the wave's slack first | 1 |

In flight (numbers assigned at merge): U7 (FAQ and collections), U10 (SEO), U17 (two-step sign-in), U8, U9, U11, C9a (CRM settings), C10a (the Sales role: an enum file alone, then the rest), R9 (the preview guide, one `app.put_help_guide`), H13 (the attention list for CMS staff, after U7), R10 (numbered versions, one migration), R11 (scheduled releases and the two switches, one migration), E1 (the page section's label, its registry row and the editing-pages guide, built as the 0112 placeholder); R6 (publish) carried none. C13 (held for O-11) takes the next free number when it is released.


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
7. **A help guide is one row; nobody restates the set.** Since H11 (`0069_help_catalog.sql`,
   numbered at merge) the guides are rows of `app.help_guide_catalog`, and
   `app.help_article_set()` renders them. A slice adds or changes only its own guide with one
   top-level statement at the start of a line, outside any DO block:
   `select app.put_help_guide($guide$ {…} $guide$::jsonb, N);` (exactly the nine keys the set
   carries: slug, sort_order, minutes, tags, screens, caps, title, title_ar, body), and
   retires one with `select app.drop_help_guide('slug', N);`. N is the guide's revision as
   `main` leaves it: 0 for a new guide; every guide starts at 1 and a put that changes it
   moves it by one (`tests/fixtures/helpSet.ts` says which, and the failing test names the
   number to use). It takes a free `sort_order` (a taken one is refused, 23505). It never
   restates `app.help_article_set()`, never writes a `$help$` literal and never writes the
   catalog another way: `tests/lib/helpCentre.spec.ts` fails if it does. Its postconditions
   and pgTAP check its own guide, and a count of guides is a floor (`>= n`), never an exact
   number, so the next slice that adds one edits nothing of yours (`tests/lib/helpCentre.spec.ts`
   fails on a pgTAP `is(…)` that pins the count). Two slices that edit
   different guides need no re-base; two that edit the same guide are serial: the second
   names a revision the guide has left and fails in CI and at the push (55000) until it is
   rebuilt on the first's text and names the new revision. Pre-push gate: no newer put or
   drop of your guide on `main` than the revision you name.

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
