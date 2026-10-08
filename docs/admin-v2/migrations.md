# Migration ledger

The bookkeeping for every migration the Admin v2 program ships: what production has applied,
the numbers reserved for slices that have not merged, the rules that keep parallel lanes from
colliding, and how a migration reaches production. The standard is CLAUDE.md §8 ("Migrations
forward-only, expand/contract"), enforced by `scripts/check-migrations.mjs`; this file is how
the program applies it. No URL, credential or project reference belongs here.

## Applied

Production has applied 0001 to 0037, the same files `main` holds.

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

Each slice's file under [as-built/](as-built/) has the detail.

## Reserved

Nothing is reserved beyond 0037 yet: the next free number is **0038**. Before a wave's slices
branch, each migration the wave plans gets a row here, numbered in the wave's planned merge
order. The slice's own PR moves its row to "Applied" once production has applied the
migration, before the PR merges (Pushing to production, step 5), so the row is true when the
PR lands and nothing here is edited after a merge.

| Number | Slice | What | Wave |
|---|---|---|---|
| (none yet) | | | |

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
   slice holds (the script lists this file's lines that name the old number, and flags a new
   number reserved here). Once a file is on `main`, its number is fixed.
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
