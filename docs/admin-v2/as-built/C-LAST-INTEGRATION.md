# C-int: the six held last-wave CRM slices on one branch (HELD: merges only after O-11)

- **Lane:** CRM
- **What:** C10b ([C10B.md](C10B.md)), C9b ([C9B.md](C9B.md)), C11 ([C11.md](C11.md)), C12
  ([C12.md](C12.md)), C15 ([C15.md](C15.md)) and C16 ([C16.md](C16.md)) merged into one branch,
  then wired together where each slice left something "to the integration" or "to whichever
  merges second".
- **Branch:** `feat/crm-last-integration`, from `feat/c78-integration` (e076f30b), the base of
  all six. No PR opened. **Held**: it merges only after the owner's lawyer signs off the
  privacy-notice update (O-11) and after the C5 to C8 chain it stands on.
- **Migration:** `0141_crm_last_integration.sql` (a placeholder; the merge train renumbers it
  with the six: 0135 C9b, 0136 C10b, 0137 C11, 0138 C12, 0139 C15, 0140 C16). Expand only.

## Plan (written first; kept current)

1. Merge in this order with `git merge --no-ff`: C10b (f514a01e), C9b (a644a795), C11
   (c9cf62b9), C12 (6eea8ac8), C15 (81532f74), C16 (4854bac0). Keep both sides of every
   conflict.
2. Look for silent conflicts git does not flag: counts, tests one slice wrote that another
   changes (Sales gains `crm.contacts` in C10b, so every refused-Sales row the other five wrote
   is suspect), docs each claiming "the next" number.
3. Wire (a) to (g) of the brief, with a forward-only 0141 where SQL is needed, restating a
   function only from its latest definition with new lines marked `-- C-int`; every wiring
   change guarded by a test that fails without it.
4. Gates, read-back, this note.

Status: done (2026-11-13). The sections below are as built.

## 1. Merges and the conflicts git flagged

| Merge | Commit | Conflicts | Resolution |
|---|---|---|---|
| C10b | 10dda4bb | none | |
| C9b | be6cc78d | CLAUDE.md (C5, C6 lines both edited; C8 line vs a new C9b bullet), README (C9 row), register (L-3, L-4 vs a new L-5), `src/lib/crm/contactPage.ts` (`readRetentionMonths`) | Docs: word-level three-way merge of the edited lines, both new bullets/rows kept. Code: C10b's one-argument door reader kept and C9b's custom-fields read added to the contact page's `Promise.all`; C9b's `settings.ts` called `readRetentionMonths(sb, auth)`, now `readRetentionMonths(sb)` (silent conflict 1) |
| C11 | 838c63f2 | CLAUDE.md, README, register, `ContactsList.tsx` (props), `contactPage.ts` (round-trip comment), `contacts/index.astro` (the page's reads) | Both props (`customFields`, `companies`) and both reads kept; the list page now makes 5 round trips (silent conflict 2) |
| C12 | 8e4a2c55 | CLAUDE.md, README, crm.md (C10b review paragraphs vs C12's), register, `astro.config.mjs` (the contacts' lazy group), `backupTables.ts`, `rls_sales_role.test.sql` (fixtures), `tests/admin/dialogs.ts` | Union everywhere; the lazy group's file list holds both `MergeDuplicatesDialog` and `CompanyDrawer` |
| C15 | 6fad7d24 | CLAUDE.md, migrations.md, architecture.md (auto, word level), register, retention.md, `auditLabels.ts`, `backupTables.ts`, `rls_sales_role.test.sql`, `tests/authz/caseManifest.ts`, `adminStyles.spec.ts` | Union; the manifest kept sorted (crmImport before crmMerge) |
| C16 | 455d1299 | CLAUDE.md (§5 matrix, a bullet, §10), `astro.config.mjs` (comment and the lazy group), README, architecture.md (§3.4), register, retention.md, `auditLabels.ts`, `backupTables.ts`, `matrix.ts` (Sales' caps), `rls_sales_role.test.sql` (fixture and the helper line), `caseManifest.ts`, `matrix.spec.ts`, `sqlHelpers.spec.ts` | Union. `ROLE_CAPS.sales`: `crm.contacts` and `crm.tasks` full (C10b), `crm.files` none (C16). The matrices: Sales ✅ on contacts and tasks, ❌ on files. The helper parity line in `rls_sales_role`: 13 helpers, Sales `1100000000110`. `matrix.spec`'s "Sales never" list: `crm.files` kept, `crm.contacts`/`crm.tasks` out (C10b). The lazy group: all five lazy files |

One slip of mine, caught and fixed in the next merge: the C12 resolution wrote the lazy
group's regex with `[\/]` (one backslash: a shell quoting slip) instead of `[\\/]`; the C16
resolution restored it byte-equal to the other groups.

## 2. Silent conflicts (git merged these cleanly or not at all)

1. **The privacy card's horizon (C9b x C10b).** C10b made `readRetentionMonths` a door call
   with no tenant argument (Sales reads no `site_settings`); C9b's CRM settings reader called the
   old two-argument form. Now one reader for both screens; `crmSettings.spec` and
   `crmCustomFields.spec` follow (the door, no `site_settings` read).
2. **Round trips (C9b x C11).** Each took the People list page from 3 to 4; merged it is 5
   (P-15 note in `contactPage.ts`).
3. **Sales was refused where C10b now allows it.** C9b, C11, C12 and C15 were built before
   Sales held `crm.contacts`:
   - pgTAP: `crm_merge` (finder, dismissals read flipped to allowed; Sales left the refused
     lists whose success would change fixtures; plan 72), `crm_custom_fields` (Sales left the
     refused-values row), `rls_crm_companies` (Sales reads companies; left the refused writes),
     `crm_contacts_import` (Sales reads the bases, as designed for `crm.contacts`),
     `rls_sales_role` (the second contact C12 added; companies, dismissals and import bases are
     CRM tables Sales now reads, so they leave the anon comparison and get their own assertion;
     plan 69). The Sales successes those suites could not hold are in
     `crm_last_integration.test.sql` section 1.
   - vitest: `tests/authz/cases/crmCompanies.ts` (Sales on every row but the forget-domain
     route, `crm.settings`) and `crmMerge.ts` (Sales on all three: crm.md CRM-12 says "admin and
     sales allowed").
   - e2e (CI only, traced against the markup): `companies.e2e.ts` and `merge.e2e.ts` no longer
     list Sales among the refused, and each gains an "as sales" journey (the Companies tab opens
     with its `h1` "Companies", a company added and found, the forget-domain route 403; a pair
     Sales added is offered and merged through the route, the dropped record a 404).
     `contactsImport.e2e.ts` and `contactFiles.e2e.ts` keep Sales refused (`crm.import`,
     `crm.files`). The per-role sweep and the Z1 dialog matrix follow the capabilities, so they
     now open the Companies tab, its drawer and the Merge dialog as Sales.
4. **Legal register numbers.** C9b, C12 and C16 each filed L-5; C11 filed L-C11 and C15
   L-C15 (item f).
5. **A planner check tipped by the merged suites (C12's `crm_merge` #67).** Run after the
   other slices' suites in one database (the PGlite replay of every suite), the planner read
   the phone rule's few rows by an index-only scan of C5's unique channel index
   (`crm_contact_channels_once`, tenant first) instead of the lookup index; alone, the suite
   passed. The check now accepts either tenant-first channels index and still refuses a
   whole-table scan.
6. **Counts checked and found consistent:** the case manifest (sorted, every new row named),
   the help guides (C9b `crm-settings` rev 2, C10b `the-sales-role` rev 3 and
   `roles-and-access` rev 6: no guide is put by two slices), the restated SQL functions (no
   function is restated by two of the six; each restates from its latest definition), the
   matrix tables (`matrix.spec` parses CLAUDE.md §5 and architecture §3.4/§9.3 equal to
   `ROLE_CAPS`).

## 3. Wiring (items a to g)

### (a) A merge by Sales (C10b's standing rule)

Decided by the design: crm.md CRM-12 says "endpoints.spec rows: admin and sales allowed", so
Sales merges (no new capability). C12's review had already put the rule in the route:
`POST /api/admin/crm/contacts/merge` runs the live recheck, then claims a `pii-reveal` slot when
`!receivesLeadPiiUnasked(role)`, then the `crm-merge` limit, before anything is read; the door
keeps C6's channel ceiling (23514). Guards: `crmMerge.spec` "as Sales (C10b gives it
crm.contacts)": the slot is spent first, and a spent slot is a 429 with nothing read and the
door never called (so nothing moved); "an Admin merge spends no reveal slot". The door takes a
live Sales actor (`crm_last_integration` #9) and the authz rows allow Sales.

### (b) Files follow a merge (C12 x C16, C16-Q2)

0141's `app.crm_tombstone_follow(p_tenant, p_tombstone)` (a definer pinned to an empty
search_path, the service role's alone) moves the files of a tombstone to its own survivor; the
merge calls it right after it makes the tombstone, in its own transaction. A definer, because
no API role holds UPDATE on `crm_contact_files` (C16's "a file row is immutable"; 0141's
postcondition holds it), and it moves rows only off a record that is a tombstone, to the record
it was merged into. Objects do not move: the path is a name; nothing reads a contact id back
out of it (`files.ts` builds a path only for an upload; the download, the removal and the
erasure read `object_path` from the row; the sweep compares whole names). The merge takes C16's
per-contact lock (`crm-files:<id>`) on the record going away BEFORE it locks a row: the add
door holds that lock while its key check waits on the contact row, so taking it later could
deadlock; taken first, an add in flight finishes and is moved, a later one finds the tombstone
(P0002). The survivor may then hold more than 20 files; the add door refuses more until it is
under the ceiling (the merge is not refused for files: a Sales merge must not learn whether a
person has files). Tests: `crm_last_integration` #19, #20 (moved, paths kept), #29 (an add to
the tombstone is P0002); `crmLastIntegrationSql.spec` (the lock before `for update`, the follow
after the tombstone, no file count in the answer or the audit row).

### (c) Company, custom values, import rows

- **C12 x C11.** The survivor keeps its company, and takes the other's linked company only
  when it names no company or its free text names that same company (by C5's name key; C11's
  trigger then writes the company's name). Its own free text is never replaced (the review's
  CINT-W-1 / XS-1, section 9: the first build took the other's link whenever the survivor had
  none, and C11's trigger then overwrote the survivor's typed company). The tombstone keeps
  none (`company_id = null`), so C11's orphan trigger removes an auto-company only the merged
  record named, and the merge writes a second audit row, `crm.contact.merge.company_removed`,
  naming its id (CINT-W-4 / XS-5). Tests: #25 (taken), #26 (tombstone none), #31 (kept), #32
  (Quill Works, the auto-company, gone; the person's companies stay), #34 to #37.
- **C12 x C9b.** Survivor wins per key, the other fills gaps, and only for a field CRM settings
  still defines (a planted value of a removed field is never carried: without the filter the
  value trigger refuses the whole merge, 23514). Test: #24.
- **C12 x C15.** The tombstone's lawful-basis rows follow the survivor, so an open import's
  dedupe still names the row ("repeated in the file, of row 7"). Since the review (CINT-SEC-2 /
  XS-2, section 9) the survivor keeps both records' rows: 0141 drops C15's one-row-per-contact
  key (`crm_contact_imports_one`) and indexes the contact instead; the first build kept only the
  survivor's own row and the nightly purge deleted the other's. Tests: #27, #28
  (`crm_import_rows` answers `[{"of": 7, "row": 40}]`), #33, #42.

### (d) Erasure and retention across the slices

`crm_erase_person` (C12's restatement) needed no change: the files' rows (C16), the basis row
(C15) and the values (C9b) go with the contact by cascade, and C11's learnt domain goes with the
last channel carrying it (C11-SEC-5). The Worker's erasure keeps C16's order (the door first,
the objects after) and its preview counts what C16 counts (the person's and the tombstones'
files; after (b) they are the survivor's). Test: #46 to #48 (a merged survivor erased: no file
row, basis row or contact left; the company forgets the domain its moved e-mail carried).
Retention: 0141 restates C12's `app.purge_crm` with `-- C-int` lines: a file or a basis row
that reached a tombstone follows it before the tombstone goes, by two set-based updates, as C12
already does for leads and tasks (#38 to #42). The first build called the follow per tombstone,
which raised for a tombstone erased mid-run and held one advisory lock per tombstone to the end
of the night's transaction (CINT-SEC-1 / XS-6, section 9; #43 to #45). Companies follow C11's orphan trigger on the purge's deletes; import
batches are kept (C15: counts only, no purge yet), unchanged.

### (e) Sales and files (C16-Q3)

Default kept: `crm.files` stays Admin's (`ROLE_CAPS`, both matrices, `matrix.spec` "never
crm.files", `rls_sales_role` "no file", `crm_last_integration` #7 and #8: Sales reads no file
and both file doors refuse a Sales actor; the authz rows and `contactFiles.e2e.ts` keep Sales
refused).

### (f) Legal register numbering

| Slice | Filed as | Now |
|---|---|---|
| C9b | L-5 | L-5 |
| C11 | L-C11 | L-6 |
| C12 | L-5 | L-7 |
| C15 | L-C15 | L-8 |
| C16 | L-5 | L-9 |

Every reference moved: the register rows (each says what it was filed as), CLAUDE.md's slice
bullets and the C16 line in §3, README's rows and index, `docs/retention.md`, the as-built notes
of C11, C12, C15 and C16, and the comments in 0138 and 0139. No test reads the register. C13
(built elsewhere, `L-C13`) takes the next free number, L-10, when it joins. The proposed
exception "EXC-014 (proposed)" keeps its number: `docs/security-exceptions.md` holds EXC-001 to
EXC-013 on this branch and on main; no pre-existing row was touched.

### (g) Everything else left to the integration

- C12 departure 8 (flip the Sales lines): done (section 2, item 3).
- C11's "C10b's merge must move Sales out of the refused list in both e2e files": done
  (`contacts.e2e.ts` by C10b, `companies.e2e.ts` here).
- C16 departure 3 and C16-Q2: done (b). C16-Q3: (e).
- C10b Decision 3 and C10B-COR-1 ("whichever merges second checks both still hold"): checked
  (a); crm.md §10's sentence now says so.
- C12 departure 2 (the finder's domain rule, "joins when channels carry a domain index"): C11
  gives channels `domain_hmac`, but the rule also needs a name-similarity threshold and its own
  register question (comparing domain hashes to suggest duplicates). **Not built; recorded as a
  follow-up slice** (a restatement of `app.crm_duplicate_candidates`).
- The learnt domain of a deduplicated channel: when both records hold one e-mail and only the
  dropped copy carries the domain index, the merge keeps the survivor's copy (C12-COR-1) and the
  company forgets the domain if nothing else carries it (C11-SEC-5). Accepted: forgetting is
  the privacy-safe side, and a later inquiry can teach it again.

## 4. Departures

- Files are moved by a definer (`app.crm_tombstone_follow`), not by giving the service role
  UPDATE on `crm_contact_files` and `crm_contact_imports`: both slices hold those rows
  immutable to every API role, and their postconditions say so.
- The merge's answer, its audit row and its `merged` timeline line carry no count of files or
  basis rows (Sales merges and holds no `crm.files`).
- The merge preview's words ("notes, tasks and timeline move.") do not mention files (an owner
  question below).

## 5. Owner questions

- **CI gate B (`npm run size`) is expected red on this branch** until the owner decides the
  450 KB tripwire (CINT-W-2): the PR must say so. Raise it with a CLAUDE.md §2 amendment, or
  cut lazy-chunk weight? Never raised here.
- **Moving files on a merge** (register L-7 note e, L-9): a Sales user can merge a record that
  holds files without knowing it. Keep, or have such a merge need an Admin (which would tell a
  Sales user the person has files)?
- **Files past the ceiling after a merge:** a survivor may hold more than 20 files (no
  refusal, so a Sales merge reveals nothing about files). Acceptable, or refuse such a merge
  (it would tell a Sales user the person has files)?
- **The merge preview's words for an Admin:** add "files" to "notes, tasks and timeline
  move."? (Sales would see the word too; it says nothing about a given person.)
- **The Sales guide** (`the-sales-role`, C10b's revision 3) says Sales works contacts and
  tasks; it does not yet name companies or merging. A guide revision is a small follow-up.
- **C12's finder domain rule** (g): build it as its own slice?
- Carried from the slices, unchanged: the admin bundle sum over the 450 KB tripwire (not
  raised); C16-Q1 (sign EXC-014 or hold C16); C10b's three questions; the register lines L-5 to
  L-9 for the lawyer with O-11.

## 6. Tests

- pgTAP `supabase/tests/crm_last_integration.test.sql` (50 since the review; the numbers in
  section 3 are the review's): Sales across the slices (1 to 17), the merge's carry (18 to 37),
  retention (38 to 45), erasure (46 to 48), the follow (49, 50). The red runs below were made
  on the first build's 32.
  Red: the suite against a `git archive` copy with 0141 removed aborts at the first merge
  (23514, the planted value); with 0141's lines taken out one group at a time
  (`scratchpad/cint_tools/mut0141.py`): the custom filter (the merge aborts, 23514), the company
  taken (#14), the tombstone's company cleared (#15, #21), the follow in the merge (#11, #12,
  #16, #17, #22), the follow in the purge (#26).
- vitest `tests/lib/crmLastIntegrationSql.spec.ts` (5; 9 since the review): the two restatements equal C12's copies
  plus the marked lines; the lock order; no file count; the follow's shape. Red: without 0141
  the file is missing and every case fails.
- The flipped suites and rows of section 2.

Red for the flipped rows of section 2: before the flips, the full PGlite replay failed
`crm_custom_fields` (5), `crm_merge` (10 and an abort), `rls_crm_companies` (6),
`crm_contacts_import` (1) and `rls_sales_role` (3), and the full vitest failed 12 (`endpoints`
10, `crmCustomFields` 1, `crmSettings` 1). Red for `crmLastIntegrationSql.spec` on a
`git archive` copy (`scratchpad/cint_mut`, its `node_modules` junction removed before the copy
was deleted): without 0141 the file fails to load; with the merge's follow line taken out 2
fail, with the company line taken out 1 fails; the copy with 0141 as built passes 5 of 5.

## 7. Gates (2026-11-13, the branch head)

- `astro check`: 0 errors, 0 warnings (80 hints); `tsc --noEmit`: clean.
- `prettier --check .`: clean.
- vitest, the whole suite with `--testTimeout=60000` (on 5c90472e, the wiring's head; only docs
  and one pgTAP file changed after it): 475 files passed, 1 skipped; 12 190 tests passed, 21
  skipped; no failure to re-run. After the docs: the 68 specs that read CLAUDE.md, the README,
  crm.md, retention.md or migrations.md, with `crmMerge.spec`: 4 419 passed.
- `check-migrations.mjs origin/main`: ok (0131, 0133 to 0141 over 0130).
- The PGlite replay of every migration with all 99 suites: 97 pass; `audit_chain` #12 and
  `grants_app_schema` section 8 fail, as on main. `crm_last_integration` 32 of 32.
- Read-back `scratchpad/readback_cint.sql` (copy in the ops backup), replayed: 23
  expectations, every one matched but `server_version_num` (PGlite 170005, production 170006).
- `npm run build` with the CI dummy environment: ok.
- `node scripts/admin-bundle.mjs`: the chunk plan holds; AdminContactsList, AdminContactDetail
  and AdminContactCompanies 177.2 KB, AdminImportContacts 163.8 KB, AdminCrmSettings 235.3 KB,
  the heaviest screen 235.3 KB (every screen within 300 KB).
- `npm run size`: the public routes 26.85 KB; the admin sum **485.55 KB, over the 450 KB
  tripwire** (each slice measured 466 to 473 KB alone; the six together add their lazy chunks).
  Not raised, its glob unchanged: the open owner question.
- `contrast-audit.mjs`: PASS (the merged admin CSS of C9b, C12 and C15).
- e2e runs only in CI; the steps added in `companies.e2e.ts` and `merge.e2e.ts` were traced
  against the markup and the routes (the `h1` "Companies", the 403 of the forget-domain route,
  the duplicates GET, the merge POST and the 404 of the record merged away).

## 8. Visual baselines

Sales' sidebar and screens change with C10b (Contacts and Tasks) and now with the Companies tab
and the Merge duplicates button: re-make the Sales pictures with the hand-run "Admin visual
baselines" workflow after the merge.

## 9. The review (2026-11-13)

Sixteen findings (security, correctness and cross-slice lenses), each checked against the code
before it was touched; none was refuted by a skeptic, and none on re-check. Red/green: the new
pgTAP and spec run against a `git archive` copy of the reviewed head (f410dd75) under
`scratchpad/cint_fix_mut`, its `node_modules` junction removed before the copy was deleted.

| Finding | Verdict | What changed | Guarded by (red on f410dd75) |
|---|---|---|---|
| CINT-SEC-1, XS-6 (the purge's follow can abort the night's run; a lock per tombstone) | Real (the raise and the unbounded locks both confirmed by reading; the race reproduced in PGlite by a test trigger that erases the other pair's survivor while the run moves the first file) | `app.purge_crm` moves files and basis rows with two set-based updates, as C12 moves leads and tasks; no follow, no lock, nothing that raises. The merge keeps the follow and its lock | pgTAP #43 to #45 (red: the run raised P0002, rolled back, `2 0 0`); spec "never the raising follow" |
| CINT-SEC-2, XS-2 (a merge destroyed the dropped record's lawful-basis row; the register was not told) | Real | `crm_contact_imports` keeps every basis row: 0141 drops `crm_contact_imports_one`, adds `crm_contact_imports_contact_idx`; the follow moves every row. Register L-7 notes (e), (f), (g), with notes in L-8 and L-9: files move on a merge (Sales included, no file count), the bases kept and not linked to each value, the inquiry-plus-import case, the removed auto-company; questions for the lawyer | pgTAP #33, #42 (red: `b002:9` left on the tombstone, then deleted); spec "keeps every lawful-basis row"; postcondition |
| CINT-SEC-3, XS-3 (no database-layer row for Sales' company writes or a stale Sales token) | Real (a test gap; the behaviour was right) | Sales rows in `crm_last_integration` section 1: update, contact link, unlink (naming the removed auto-company), create, delete, a direct insert naming another tenant's person (the owner rule's 23514, the same answer as an inactive colleague's), and demoted, switched-off and locked Sales tokens reading no company, dismissal or basis and refused by every door, the merge door included | pgTAP #10 to #17. Coverage, so green on f410dd75 too; proven to bite by mutation: Sales out of `app.role_crm_contacts` fails #10 to #14; without the live policies on companies and basis rows the demoted token reads 4 companies, changes Palm Studio and deletes 4 rows (#15) |
| CINT-W-1, XS-1 (a merge replaced the survivor's own free-text company) | Real (the reviewer's PGlite probe reproduced it) | The merge takes the other's link only when the survivor names no company or names that same company (C5's name key) | pgTAP #34 to #36 (red: `Xenon Trading` over `Foo Typed Ltd`); spec |
| CINT-W-2 (the admin bundle sum over the 450 KB tripwire) | Real, not fixed: an open owner question | Not raised, its glob unchanged; section 5 says the PR must state CI gate B is expected red | n/a |
| CINT-W-3, XS-4 (a removal racing a merge left a row whose object was gone) | Real (a race: traced, and reproduced as its end state) | 0141 restates `public.crm_file_remove` (C16's copy plus `-- C-int` lines): when the named record's own row is gone, it removes that one file from the survivor of the record named, if the record is a merge tombstone. The route is unchanged | pgTAP #21 to #23 (red: P0002 and the row left); spec "restates the file removal" |
| CINT-W-4, XS-5 (a merge that removed an auto-company left no audit of it) | Real | The merge captures the other's company after the tombstone lets it go and, when C11's orphan rule took it, writes a second audit row `crm.contact.merge.company_removed` (keep, drop, removed_company: ids only) in its own transaction, after the merge row (C12's audit line is kept byte for byte, so the restatement check still holds). `auditLabels.ts` has its words | pgTAP #37 (red: no row); spec; `auditLabels.spec` (red: the action had no words) |
| CINT-W-5 (CLAUDE.md, README and architecture.md still said "Sales none unless C10b's design gives it") | Real | "Sales none: C16-Q3, decided at the C-int integration" in all three | docs only |

Not changed, recorded: the import's dedupe (`crm_import_rows`) reads one basis row of the open
batch for a contact; a merged record holding two rows of one batch answers either (both are
true). The merge does not move more than the files a survivor can show (the 20-file ceiling
stays the add door's).

Gates, as run on the review's head:

- `astro check`: 0 errors, 0 warnings (80 hints); `tsc --noEmit`: clean.
- `prettier --check .`: clean.
- vitest, the whole suite with `--testTimeout=60000`: 475 files passed, 1 skipped; 12 195
  tests passed, 21 skipped; nothing to re-run. After this note: the 83 specs that read the
  docs, with `crmLastIntegrationSql` and `auditLabels`: 4 793 passed.
- `check-migrations.mjs origin/main`: ok (0131, 0133 to 0141 over 0130).
- The PGlite replay of every migration with all 99 suites: 97 pass; `audit_chain` #12 and
  `grants_app_schema` section 8 fail, as on main. `crm_last_integration` 50 of 50.
- `npm run build` with the CI dummy environment: ok. `node scripts/admin-bundle.mjs`: the chunk
  plan holds; the contacts screens 177.2 KB, AdminImportContacts 163.8 KB, AdminCrmSettings
  235.3 KB, the heaviest screen 235.3 KB (every screen within 300 KB).
- `npm run size`: the public routes 26.85 KB; the admin sum 485.55 KB, over the 450 KB
  tripwire, unchanged by the review (CINT-W-2). Not raised, its glob unchanged.
- `contrast-audit.mjs`: not run (no admin CSS changed).
