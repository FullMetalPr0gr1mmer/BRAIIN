# W0-b: endpoint cases per feature, the route coverage check, the renumber script

- **Lane:** Wave 0 (the shared files split before the lanes run in parallel)
- **Design:** the program's Wave 0 plan (adopted 2026-10-05), whose W0-b is "test
  registries + `endpointCoverage.spec` completeness + `scripts/renumber-migration.mjs`"; the
  README's "Wave 0" summarises the wave
- **PR:** from branch `test/w0b-registries`
- **Migrations:** none

## What was built

- **Endpoint cases per feature.** The authorization matrix's rows moved out of the one `CASES`
  list in `tests/authz/endpoints.spec.ts` into a module per admin feature,
  `tests/authz/cases/<feature>.ts` (21 today), collected by `tests/authz/cases/index.ts` with
  `import.meta.glob`, subfolders included (`cases/crm/notes.ts` is the feature `crm/notes`).
  The shared pieces (principals, sessions, the stub client, the request context, the `Case`
  type) moved verbatim to `tests/authz/harness.ts`. The 89 existing cases kept their name,
  method, URL, body, allow list and route module, and `endpoints.spec.ts` runs the same
  assertions over them.
- **The route coverage check**, `tests/authz/endpointCoverage.spec.ts`. Every handler exported
  under `src/pages/api/admin` is driven by a case (matched by the module its `load()` imports)
  or named in `NOT_DRIVABLE` with the reason. It also checks that each exception is a real
  handler no case drives, that each case's URL is served by the route it loads, that the
  route glob and the case glob each see every file on disk, and that every case is pinned by
  name in `tests/authz/caseManifest.ts`, so a module or a row lost in a merge fails by name.
  80 handlers had no row; 81 rows now drive them (`PATCH /api/admin/leads/[id]` has two: a
  status, and internal notes, which add `leads.pii`), and every role allowed on them gets past
  the capability check against the stub: 170 cases, 857 matrix tests.
- **Sign-in and sign-out**, the two handlers the matrix cannot drive, have their guards driven
  in `tests/authz/login.spec.ts`: the middleware refusing a cross-site or tokenless POST;
  sign-in passing without a session while sign-out answers 401; one byte-identical 401 for
  every failed sign-in, and a 400 for a body that is not JSON, before anything is looked up;
  423 on the fifth failure, and before a locked address's password is tried; the lockout
  failing closed; a good sign-in recorded and audited.
- **`scripts/renumber-migration.mjs`.** When another branch merged a migration of the same
  number first (check-migrations rule 4), `node scripts/renumber-migration.mjs <file>
  [--base origin/main] [--dry-run]` renames the branch's file with `git mv` to the lowest
  number above the base's highest and the branch's earlier new migrations, passing over any
  number the reservation ledger ([migrations.md](../migrations.md), "Reserved") holds for
  another slice. It rewrites the file name wherever it appears but the ledger, which it never
  edits, and a bare number in `supabase/tests`, `docs`, CLAUDE.md and the new migrations'
  headers only on lines the branch added (`git diff -U0` against the base), and only while
  no other migration has that number. It prints each file it changed with its count of
  rewrites, and under it a line for each bare number it moved (a file name's rewrite is
  counted, not printed), then every line it left that still names the old migration, with
  the reason, for a reader to check. Tested on its pure parts and end to end in throwaway
  repositories, with every `GIT_*` variable dropped so a run started from a git hook cannot
  reach the real repository.
- **check-migrations' failure** names the script, after merging the base (one line).
- **CLAUDE.md §9** names where an admin route's cases live (one bullet).

## Departures from the plan, and why

- **Two handlers are exempt from the coverage check.** The plan asked for a case for every
  exported method. Sign-in is reached without a session and checks no capability, so the
  matrix's "anon is refused" row cannot hold. Sign-out needs a session, not a capability,
  and its 401 comes from the middleware, which the matrix does not run. Both are in
  `NOT_DRIVABLE` with that reason, and `login.spec.ts` drives their guards. The first version
  said the e2e setup (`tests/admin/staff.setup.ts`) covered sign-in's 401 and 423; it only
  signs in successfully, so the review asked for the spec.
- **The case manifest is beyond the plan.** Collected by glob, a module dropped in a merge
  would leave no trace. `caseManifest.ts` lists every case by name, one line each in sorted
  order, so a lost one fails by name and parallel slices rarely touch the same line.
- **The renumber script follows the ledger instead of editing it.** The integration check
  found the first version moved a file onto the next number even when the ledger held it for
  another slice, and left the slice's own row unmentioned. It now passes over such numbers
  (the ledger's rule 3), so that slice keeps its number if it merges first, and lists the
  ledger's lines that name the old migration (by file name, by number, or by a range that
  holds the number) without rewriting any: the ledger is the program's plan, and its rows
  move by hand. A second review found a Reserved row's file name rewritten under a Number
  cell that kept the old number, so the ledger is now skipped whole. Whose a number is comes
  from the Reserved row of the file's current number, read from the base's ledger too, so a
  branch that re-planned its own row gets the number it planned. There is no override flag:
  taking another slice's number is a re-plan of both rows.
- **Review fixes to the script.**
  - It refuses to run until the base is merged: before that, the diff counts every line the
    base changed since the fork as the branch's.
  - A bare number on an added line is left to a reader when the line's base side already
    named that number (CLAUDE.md keeps a paragraph on one line, so one line can name both
    migrations). The first version also left a line naming the base's migration of that
    number by its file name; a second review found that too narrow, so no bare number moves
    at all while another migration has it, and each is listed with that migration's name:
    the base's own (a new header's "Depends on 0037", meaning main's, became 0038), or a
    second new one of the branch's that keeps it (parting two new 0040s rewrote the header
    of the one that stays).
  - A file only moves up. One check-migrations accepts stays where it is, instead of closing a
    gap into a number another slice may hold.

## Open

- **The lockout counting has no pgTAP test.** It is SQL (0009: `login_is_locked`,
  `register_failed_login`); `login.spec.ts` stubs it with the same contract.
- **A good sign-in does not reset the lockout count.** `login_is_locked` counts every failure
  in the 15-minute window, and `register_successful_login` resets `profiles.failed_login_count`,
  which that count does not read. So four failures, a good sign-in and one more failure lock
  the address. That is stricter than `src/lib/auth/lockout.ts` reads ("Clears the failure
  counter"); left as it is, for the owner to decide.
