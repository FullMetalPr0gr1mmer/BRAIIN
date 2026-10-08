# W0-a: the standard's layout, the lanes, the as-built files and the migration ledger

- **Lane:** Wave 0 (the shared files split before the lanes run in parallel)
- **Design:** the program's Wave 0 plan (adopted 2026-10-05), whose W0-a is "CLAUDE.md
  long-line split + lane sections, `as-built/`, `migrations.md`, runbook rollback floor after
  0033"; the README's "Wave 0" summarises the wave
- **PR:** from branch `docs/w0a-standard-layout`
- **Migrations:** none

## What was built

- **CLAUDE.md §8 in bullets.** The opening paragraph of Data model & schema is one bullet per
  sentence; File / layout conventions is one bullet per path entry, with "Admin code" and
  "Admin layers (F2)" as bullet lists under their labels. No rule was added, removed or
  weakened, and §1 to §7 and §9 to §11 are unchanged; two relative references were re-pointed
  after the move.
- **Admin v2 lanes**, at the end of §8: one subsection per track (UI, Releases, CRM), each
  opening with pointers to where the merged slices' rules already live. The program pointer
  (`docs/admin-v2/`) moved there from the Admin code paragraph, and the Releases lane points
  at the `contentClient()` seam (W0-d) that R8 builds on.
- **One as-built file per slice** under `as-built/`, replacing the README's shared table: F0
  to F4a moved verbatim; H5 to H8 and C1a-1 to C2b written from their merges and commit
  messages and checked against the code and the designs. The README keeps an index.
- **The migration ledger**, [migrations.md](../migrations.md): what production has applied
  (0001 to 0037), the reservations, six rules, and the steps for pushing to production
  (process only: no URL, credential or project reference).
- **The runbook's rollback floor** (launch runbook §10): #43, `cc8c6c4`, set by 0033's
  contraction; 0037 does not move it.
- **After the integration check** (the four Wave 0 branches merged together): the README's
  "Wave 0" section, with the map of what Wave 0 moved and the F0 harness extension recorded
  as open; the README's two pointers to old paths (`nav.ts`, the `endpoints.spec` rows);
  rule 3's sentence on the renumber script and the ledger; the Wave 0 group in the as-built
  index.

## Departures from the plan, and why

- **More of §8 is split than planned.** The plan named the File / layout paragraph and the
  Admin code paragraph. The opening paragraph of Data model & schema was another single line
  that data-model slices append to (C1a-1's 0033 sentences went there), so it is split the
  same way. The i18n / Commit-PR paragraph stays one line on purpose: #41 rewrites it.
- **Leads v2 moved whole, not condensed to one line.** The lanes hold one line per slice with
  the detail in the track's design. The CRM lane carries the Leads v2 rules (0034 to 0036)
  verbatim, split into sub-bullets, and Data model & schema keeps a pointer to them: Wave 0
  changes no rule, and moving rule text into crm.md, a design the README overrides, would have
  taken it out of the standard. Slices from now on add one line.
- **A slice's as-built file and ledger row travel in its own PR.** The plan's per-slice
  pipeline updates `as-built/` after each merge, but merges are owner-gated (P-13), so a
  post-merge edit would need a second PR per slice and would drift without one. A slice's PR
  carries its file and its index line, and moves its ledger row to "Applied" once production
  has applied the migration, before the merge (migrations.md, Pushing to production, step 5).
- **The four Wave 0 index lines are W0-a's.** By the rule above each slice adds its own line,
  but the four Wave 0 branches were built in parallel, so W0-a adds all four and W0-b to W0-d
  add only their files. Until a slice merges, its line links a file that is not there yet.
- **Reservations start at 0038, and none is made yet.** The plan reserved from 0037 for "H7";
  that partition hardening was renamed H8 and took 0037 (#51) before any reservation was
  made. Wave 1 reserves its numbers before its slices branch (rule 2).
- **Rule 3 does not leave the ledger to the renumber script.** The integration check found
  that `scripts/renumber-migration.mjs` moves a file to the number just above `main`'s
  highest, which can be another slice's reservation, and leaves the ledger row where it was.
  Rule 3 now says the slice moves its own row by hand and takes the lowest number above
  `main` that no other slice holds; W0-b's script lists the ledger lines that name the old
  number and flags a reserved one.
- **#41 rewrites runbook §10 with the same floor.** Whichever of #41 and this slice merges
  second keeps #41's paragraph and adds this one's 0037 note.
