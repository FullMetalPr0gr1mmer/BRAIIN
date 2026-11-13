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
5. **Counts checked and found consistent:** the case manifest (sorted, every new row named),
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
person has files). Tests: `crm_last_integration` #11, #12 (moved, paths kept), #18 (an add to
the tombstone is P0002); `crmLastIntegrationSql.spec` (the lock before `for update`, the follow
after the tombstone, no file count in the answer or the audit row).

### (c) Company, custom values, import rows

- **C12 x C11.** The survivor keeps its company and takes the other's when it has none
  (`company_id = coalesce(k.company_id, d.company_id)`; C11's trigger then writes the company's
  name); the tombstone keeps none (`company_id = null`), so C11's orphan trigger removes an
  auto-company only the merged record named. Tests: #14 (taken), #15 (tombstone none), #20
  (kept), #21 (Quill Works, the auto-company, gone; the person's companies stay).
- **C12 x C9b.** Survivor wins per key, the other fills gaps, and only for a field CRM settings
  still defines (a planted value of a removed field is never carried: without the filter the
  value trigger refuses the whole merge, 23514). Test: #13.
- **C12 x C15.** The tombstone's lawful-basis row follows the survivor when the survivor has
  none (`crm_contact_imports` is one row per contact), so an open import's dedupe still names
  the row ("repeated in the file, of row 7"); when the survivor has its own, it keeps it and the
  other's goes with the tombstone. Tests: #16, #17 (`crm_import_rows` answers
  `[{"of": 7, "row": 40}]`), #22.

### (d) Erasure and retention across the slices

`crm_erase_person` (C12's restatement) needed no change: the files' rows (C16), the basis row
(C15) and the values (C9b) go with the contact by cascade, and C11's learnt domain goes with the
last channel carrying it (C11-SEC-5). The Worker's erasure keeps C16's order (the door first,
the objects after) and its preview counts what C16 counts (the person's and the tombstones'
files; after (b) they are the survivor's). Test: #28 to #30 (a merged survivor erased: no file
row, basis row or contact left; the company forgets the domain its moved e-mail carried).
Retention: 0141 restates C12's `app.purge_crm` with three `-- C-int` lines: a file or a basis
row that reached a tombstone follows it before the tombstone goes, as C12 already does for leads
and tasks (#24 to #27). Companies follow C11's orphan trigger on the purge's deletes; import
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

- pgTAP `supabase/tests/crm_last_integration.test.sql` (32): Sales across the slices (1 to 9),
  the merge's carry (10 to 22), retention (23 to 27), erasure (28 to 30), the follow (31, 32).
  Red: the suite against a `git archive` copy with 0141 removed aborts at the first merge
  (23514, the planted value); with 0141's lines taken out one group at a time
  (`scratchpad/cint_tools/mut0141.py`): the custom filter (the merge aborts, 23514), the company
  taken (#14), the tombstone's company cleared (#15, #21), the follow in the merge (#11, #12,
  #16, #17, #22), the follow in the purge (#26).
- vitest `tests/lib/crmLastIntegrationSql.spec.ts` (5): the two restatements equal C12's copies
  plus the marked lines; the lock order; no file count; the follow's shape. Red: without 0141
  the file is missing and every case fails.
- The flipped suites and rows of section 2.

## 7. Gates

See the end of this note (filled in as they ran).
