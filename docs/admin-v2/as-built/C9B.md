# C9b: CRM settings for contacts, custom contact fields (HELD: merges only after O-11, C5 to C8)

- **Lane:** CRM
- **Design:** [crm.md](../crm.md) §4.7 (`crm_settings.custom_fields`), §5.1 (`crm_contacts.custom`,
  "validated by the API against crm_settings.custom_fields"), §11 screens 6, 7 and 11 (Details
  with custom fields; the add drawer; CRM settings: Contact stages read-only, Custom fields, Data
  & privacy), "CRM-9" (the contacts half C9a left); README's C9 row ("contact settings and custom
  fields come with C7"); the prototype's `/crm/settings` (cards "Contact stages", "Custom fields",
  "Data & privacy"); the C5 to C8 as-built notes, and C9a's ([C9a](C9a.md)).
- **PR:** not opened (branch `feat/c9b-custom-fields`, from `feat/c78-integration` e076f30b).
  **Held**: it merges after the owner's lawyer signs off the privacy-notice update (O-11) and
  after C5 (#143), C6 (#145), C7 (#146), C8 (#147) and the C7 + C8 integration (#148).
- **Migration:** `0135_crm_custom_fields.sql` (a placeholder; the merge train renumbers it).
  Expand only.

## Plan (written before building; kept current)

Status: built (2026-11-12), held. Every gate below ran on the head of `feat/c9b-custom-fields`.

### Scope

- **Custom contact fields**: up to 12 definitions `{key, label, type}`, type text, number or
  date (crm.md §4.7 and the prototype; C6's speculative `select` and `boolean` types are
  dropped, no field of either kind can exist yet). Stored in `crm_settings.custom_fields`,
  edited on CRM settings (`crm.settings`, Admin), shown and edited on a contact's page
  (Details) and in the Add contact drawer (`crm.contacts`).
- **Validated in both layers**: the Worker checks values against the definitions it reads (as
  the caller); the database checks them again (a trigger on `crm_contacts.custom`), so a direct
  write through the staff column grant cannot store a value the screen would not.
- **Contact stages card** (read-only, the prototype's four descriptions) and a **Data & privacy
  card**: the retention horizon in words (read from `site_settings.retention`, changed in
  General settings, linked for `settings.general` holders), and "Erase a person's data"
  (`crm.erase`): a contact picker (C6's POST lookup) that opens C7's erase dialog, the picker
  C7 left to "the C9b settings card" (C7 departure 6).
- No new capability: `crm.settings` (Admin) edits the definitions, `crm.contacts` holders fill
  the values, `crm.erase` erases.

### SQL (0135)

- `app.crm_custom_fields_ok(jsonb)` (immutable, used by a CHECK): an array of at most 12
  objects with exactly `key` (`^[a-z][a-z0-9_]{0,39}$`), `label` (1 to 60 characters, trimmed, no
  control character) and `type` (`text`, `number`, `date`); every key once.
- `crm_settings.custom_fields jsonb not null default '[]'` with that CHECK; the column joins the
  staff UPDATE column grant (policies `crm_settings_write` and the RESTRICTIVE
  `crm_settings_write_live` already decide who: a live `crm.settings` holder of the tenant).
- The three stamp triggers (0113's) restated with `custom_fields` in their column lists, so a
  definitions save moves the row's version (the cards share it) and its stamps.
- `app.tg_crm_settings_custom_fields` (BEFORE UPDATE OF custom_fields): a field that stays keeps
  its type (23514 naming `crm_settings_custom_field_type`), so every stored value always fits
  its field. A key cannot be renamed: a renamed key is a removal plus a new field.
- `app.tg_crm_settings_custom_removed` (AFTER UPDATE OF custom_fields, a definer): the values a
  removed field held are deleted from every contact of the tenant in the same statement (no
  orphan values nobody can see; data minimisation). The contacts' row trigger counts it as an
  edit by the person who removed the field (version, `details_changed` with `custom`), never as
  a person editing that contact (`staff_edited` is a direct write's only).
- `app.tg_crm_contact_custom` (BEFORE INSERT OR UPDATE OF custom on `crm_contacts`, a definer):
  each key whose value is new or changed must be a defined field of the contact's tenant, and
  the value must fit its type: text a string of at most 500 characters, number a JSON number,
  date a real `YYYY-MM-DD` date; JSON null is allowed (empty). 23514 naming
  `crm_contacts_custom_fields`.
- Postconditions for both grant regimes; the help guide `crm-settings` at revision 1 (H11's put)
  with the new cards.

### Worker

- `packages/schemas/crm.ts`: `CUSTOM_FIELD_TYPES` = text, number, date; `MAX_CUSTOM_FIELDS` = 12;
  `CustomFieldDefinitionSchema` strict `{key, label, type}`; `CustomFieldsSaveSchema` (≤ 12,
  each key once); `CrmSettingsSaveSchema` gains `customFields`.
- `src/lib/crm/contactCustom.ts`: `readCustomFields(sb, auth)` (as the caller; lenient shaping
  for display, strict for validation), `validateCustomValues` for the three types,
  `mergeCustom` (a PATCH sets the keys it sends, a null clears one, the rest are kept; nulls are
  never stored).
- `GET/PUT /api/admin/crm/settings`: the definitions, the retention months, `canErase` and
  `canEditRetention` (UX flags from `ROLE_CAPS`; the routes they lead to check again); a PUT
  of `customFields` at the row's version, audited `crm.settings.update` with `custom_fields`
  and counts (added, removed), never labels or values.
- Contacts: `POST /api/admin/crm/contacts` and `PATCH …/[id]` validate against the tenant's
  definitions; `GET …/[id]` and the pages carry them (the contact page's round trips 8 → 9,
  the list page's 3 → 4, P-15).

### Screens

- CRM settings: Custom fields card (rows of Label, Type, and Key for a new field, derived from
  the label until typed; Add field up to 12; Remove asks to confirm when a saved field goes:
  "what every contact holds in it is deleted"), Contact stages card (read-only), Data & privacy
  card. Each card has its own Save; nothing autosaves.
- A contact's Details card draws the three types; the Add contact drawer gains the fields.

### Tests

- pgTAP `supabase/tests/crm_custom_fields.test.sql`: the definitions' CHECK; writes as admin,
  content_creator, seo, developer, sales, another tenant's admin, anon and stale tokens
  (demoted, switched off, locked); the version; a kept type; removal clearing values (and
  nothing in another tenant); value validation through the staff grant and the create door;
  grants and function pins.
- vitest: schemas, validation and merge, the settings route (read, save, audit, 409), the
  contact routes against definitions, the screen's rules, the guide, the copy rules.
- e2e (CI only): CRM settings as Admin (define a field, see it on a contact, fill it, remove
  it with the confirm), traced against the markup.

## As built

Everything in the plan above, in these places:

- **SQL** `supabase/migrations/0135_crm_custom_fields.sql` (expand only): `app.crm_custom_fields_ok`
  and the CHECK `crm_settings_custom_fields_ok`; `crm_settings.custom_fields` in the staff UPDATE
  column grant; the three stamp triggers restated with it; `crm_settings_custom_fields` (a kept
  field keeps its type, 23514 `crm_settings_custom_field_type`); `crm_settings_custom_removed`
  (definer: a removed field's values leave every contact of the tenant in the same statement);
  `app.crm_custom_date_ok` and `crm_contacts_custom_fields` (definer: each new or changed value is
  a field of the contact's tenant and fits its type, 23514 `crm_contacts_custom_fields`); the
  `crm-settings` guide's next revision. pgTAP `supabase/tests/crm_custom_fields.test.sql` (41 since the review):
  admin, content_creator, seo, developer, sales, another tenant's admin, anon, and stale tokens
  (demoted, switched off, locked); `crm_settings.test.sql` follows the new column.
- **Worker** `packages/schemas/crm.ts` (the definition and save schemas, three types, 12 fields);
  `src/lib/crm/contactCustom.ts` (read as the caller, validate, merge); `src/lib/crm/settings.ts`
  and `GET/PUT /api/admin/crm/settings` (the definitions, the privacy view, audit counts only);
  the contact routes (`POST …/contacts`, `GET/PATCH …/contacts/[id]`) and pages read and check
  the definitions (C6's refusal of every custom value is lifted per definition).
- **Screens** CRM settings: `CustomFieldsCard`, `ContactStagesCard` (read-only),
  `PrivacyCard` with `EraseFinder` (C7's erase dialog loaded with `import()` on the first pick);
  a contact's Details and the Add contact drawer draw the fields (`contacts/customFields.tsx`).
- **Tests** vitest `tests/lib/crmCustomFields.spec.ts` (schemas against the migration, the value
  check and merge, both routes, the cards' rules, the guide); `contactsApi.spec.ts` and
  `crmSettings.spec.ts` follow; e2e (CI only) `tests/admin/crm-custom-fields.e2e.ts`;
  `EraseFinder` joins the Z1 dialog axe matrix (`tests/admin/dialogs.ts`).
- **Docs** CLAUDE.md §8, README (C9 row), `migrations.md`, `deviations.md`, register L-5.

Fix on resume (2026-11-12): a new field could take the key of a saved field the same save
removed. The card's question then said the values were deleted while the database, seeing the
same key, kept them (or refused a changed type). The card now derives new keys clear of saved
ones and refuses a reused key before asking (`fieldsProblem(drafts, loaded)`; guarded in
`crmCustomFields.spec.ts`, which fails without the fix).

## The review (2026-11-12)

Seven findings (two security, five correctness), none refuted by the skeptics. Every one was
checked against the code first and all were real (C9B-SEC-1 and C9B-COR-1 are one race,
C9B-SEC-2 and C9B-COR-5 one gap). Red/green ran on a `git archive` copy of the fixed head: the
fix's source half (schemas, Worker, screens, migration) put back to the build commit with the
new tests kept, then single mutations of the fixed migration. The fixes are in 28e9b560 (a
resumed fixer's commit) and the follow-up named in item 3. A second resume re-ran the vitest
half on a fresh `git archive` copy (the ten source files of 28e9b560 put back to 188836da, the
new tests kept): 8 of 86 failed (the retention line, FOR SHARE, the two 40P01 cases, the named
characters, year 0000 and both COR-2 cases), and all 86 passed on the fixed tree.

1. **C9B-SEC-1 / C9B-COR-1 (fixed): a value written while its field was being removed
   survived.** `app.tg_crm_contact_custom` read the definitions with a plain SELECT, and the
   removal's cascade only reached contacts its snapshot saw holding the key, so either order of
   two overlapping transactions left the value behind, unseen, until a later field took the key
   (perhaps as another type). The trigger now reads the definitions `FOR SHARE`, which
   conflicts with the settings UPDATE's row lock: a value write waits for a definitions save
   already open, then reads what it committed (and is refused); a definitions save waits for an
   open value write, so its cascade (a fresh statement snapshot) sees the value and removes it.
   Only a write that brings a new or changed value takes the lock (an early return before the
   read). The Worker's own read of the definitions is not a barrier; only the database's is.
   The two sides lock in opposite orders, so a value write to a contact that holds the very key
   being removed, at the same moment, can deadlock; PostgreSQL aborts one side (40P01), which
   both routes answer as a 409 (`contactError`, `saveCrmSettings`), and no value is left
   behind. Guards: vitest (the trigger reads `FOR SHARE` after the early return; 40P01 is an
   `OptimisticLockError` on both sides) and pgTAP #12 (the installed function reads
   `FOR SHARE`). Red without the fix: the three vitest cases and pgTAP #12. The race itself
   needs two sessions, which neither pgTAP (one session, one transaction) nor the PGlite replay
   (one connection) has; it was traced, not run.
2. **C9B-SEC-2 / C9B-COR-5 (fixed): the value matrix left out seo, sales, the switched-off
   token and anon, and nothing proved the definitions are per tenant.** The values block now
   runs O, C, S, D, L, Ad, Ao, Al (authenticated) and N (anon, 42501): none reaches a row. A new
   assertion defines a key only in T1 and another only in T2 (every other tenant defines both),
   then writes each on the other tenant's contact as the migration role: both 23514. Red: with
   the trigger reading every tenant's definitions (no tenant filter) the new assertion fails
   (`ok:1 ok:1`), and with anon granted UPDATE on `crm_contacts` the persona row fails
   (`N=ok:0`). Dropping only the `where` (first row wins) already broke the suite's own
   fixture in PGlite, but that depends on row order; the new assertion does not.
3. **C9B-COR-2 (fixed): a number or date the browser could not read cleared the stored
   value.** A `type=number` box reports `''` for "1-2" or "1e", and the form sent that as null.
   A number field is now a text box with `inputMode="decimal"`, so the form's own check
   ("Enter a number.") sees what was typed. A date keeps the browser's date picker; before
   saving, the form asks each box for `validity.badInput` (`unreadableBoxes`) and refuses with
   "Enter a date." while it is set, so a partly typed date never becomes null. The Add contact
   drawer and the Details card both ask. Guards: vitest renders the inputs (a text box with
   `inputMode="decimal"`, no `type="number"`), checks bad and good number texts and an
   unreadable date box. Red without the fix: both cases. Follow-up on resume: `unreadableBoxes`
   took a `find` returning its own all-optional type, which `document.getElementById` (an
   `HTMLElement`, no `validity`) did not satisfy, so `astro check` reported two errors after
   28e9b560; `find` now returns any object and the box is read as one that may have
   `validity`. The vitest case, which passes plain objects, still passes.
4. **C9B-COR-3 (fixed): the privacy card said leads were kept from their last activity.**
   Leads are kept N months from their arrival (`app.purge_leads`, `created_at`), contacts N
   months from their last activity (`app.purge_crm`), docs/retention.md. `retentionLine` now
   says "Leads are kept N months after they arrive, and contacts N months after their last
   activity.", and so do the guide's EN and AR items (the migration's guide revision),
   `CrmPrivacyView`'s comment, the card's header comment and crm.md §11. Guards: the vitest on
   `retentionLine` (red without the fix) and the e2e on the card, whose regex now anchors the
   whole sentence (traced against the card's paragraph).
5. **C9B-COR-4 (fixed): the Worker and the database disagreed on edge values.** The database
   used `[[:cntrl:]]`, which follows LC_CTYPE (PGlite matched U+0085 but not U+2028 or
   U+2029); the Worker refused only C0 and DEL. Both now name the same set, as 0045 does:
   `CUSTOM_FIELD_CONTROL` in packages/schemas (C0, DEL, C1, U+2028, U+2029) for labels and text
   values, the form's `CUSTOM_CONTROL` equal to it (a test), and the migration's CHECK and
   trigger the same characters from U+0001 (text holds no NUL). Year 0000, which JavaScript
   reads and PostgreSQL refuses, is refused by `isCustomDate` and the form's `isDateText`. The
   23514 `crm_contacts_custom_fields` mapping (field `custom`, "changed in CRM settings
   meanwhile, reload") had no test and now has one. With both layers agreeing, that 23514 can
   only come from definitions that changed after the Worker read them, so the reload advice is
   now true and was kept. Guards: vitest (the migration names the schema's set and no
   `[[:cntrl:]]`; C1, U+2028, U+2029, BEL and DEL refused by the Worker, the form and the
   schema; year 0000), pgTAP #4 and #15 (a C1 control and a separator in a label and in a
   value; year 0000) and the `crm_custom_date_ok` pin. Red without the fix: the vitest cases,
   pgTAP #4 (`ok:1` for U+2029 in a label) and #15 (`ok:1` for U+2028 in a value). The mapping
   test was green before (it covers existing code).

Skipped: nothing. Refuted: nothing (the skeptics refuted none, and the re-check found every
finding real).

### Departures from the design

1. A field's key and type are fixed once saved (the prototype edits both): a changed type would
   leave values of the old kind. A renamed key is a removal and a new field.
2. Removing a field deletes its values from every contact (the design only warned of orphaned
   values); nothing is kept that no screen shows.
3. The field kinds are text, number and date only (C6's speculative select and boolean dropped;
   none could exist yet).
4. Data and privacy states the retention horizon and links to General settings instead of the
   prototype's own 2, 3 or 5 years select (retention is General's, at most 24 months).
5. Round trips: the contact page 8 to 9, the contacts list 3 to 4 (P-15), one read each of the
   definitions.

### Gates (2026-11-12, head of the branch)

- `astro check`: 0 errors, 0 warnings, 72 hints; `tsc --noEmit`: clean.
- `prettier --check .`: clean (one file reformatted on resume).
- vitest, full suite with `--testTimeout=60000`: 458 files passed, 1 failed
  (`adminBundle.spec.ts`, the known hook timeout under load), 1 skipped; 11768 tests passed.
  Re-run alone with `crmCustomFields.spec.ts`: 2 files, 95 tests passed.
- `check-migrations origin/main`: ok (0131, 0133, 0134, 0135 added; origin/main's highest 0130).
- PGlite replay of all 92 SQL suites at0048: everything passes except the two known ones,
  `audit_chain` #12 (the lock check) and `grants_app_schema` section 8.
  `crm_custom_fields.test.sql`: all 39 passed.
- Production read-back (`readback_c9b.sql`, replayed): 26 expectations, one mismatch,
  `server_version_num` (PGlite 17.5 against production's 17.6).
- Build with the CI environment: ok. `admin-bundle.mjs`: the chunk plan holds; eager graphs
  AdminCrmSettings 235.3 kB, AdminContactDetail and AdminContactsList 174.1 kB (each <= 300).
  `npm run size`: public 26.85 kB; the admin sum 469.72 kB against the 450 kB tripwire (the
  known, open owner question; not raised here).
- `contrast-audit.mjs` (admin CSS changed: `crm-settings.css`): PASS.


### Gates after the review (2026-11-13, the review fixes plus the `unreadableBoxes` type follow-up)

- `astro check`: 0 errors, 0 warnings, 72 hints; `tsc --noEmit`: clean.
- `prettier --check .`: clean.
- vitest, `crmCustomFields.spec.ts` and `crmSettings.spec.ts`: 86 passed. Full suite with
  `--testTimeout=60000`: 458 files passed, 1 failed (`adminBundle.spec.ts`, its `beforeAll`
  timing out at 10 s under load), 1 skipped; 11776 tests passed. Re-run alone: 57 passed.
- `check-migrations origin/main`: ok (0131, 0133, 0134, 0135 added; origin/main's highest 0130).
- PGlite replay at0048 with `crm_custom_fields.test.sql` (all 41 passed) and
  `crm_settings.test.sql` (all 94 passed).
- Build with the CI environment: ok. `admin-bundle.mjs`: the chunk plan holds; eager graphs
  AdminCrmSettings 235.3 kB, AdminContactDetail and AdminContactsList 174.3 kB (each <= 300).
  `npm run size`: public 26.85 kB; the admin sum 469.95 kB against the 450 kB tripwire (the
  known, open owner question; not raised here).
- `contrast-audit.mjs`: not run, no CSS changed in the review fixes.

## Since the six-slice integration (C-int, [C-LAST-INTEGRATION.md](C-LAST-INTEGRATION.md))

- Sales holds `crm.contacts` (C10b), so it fills custom values; `crm_custom_fields.test.sql`'s
  refused-values row no longer lists it, and `crm_last_integration.test.sql` proves its write.
- The privacy card reads the horizon through C10b's door `public.crm_contact_retention_months`
  (one reader, `readRetentionMonths(sb)`), not `site_settings`.
- A merge (C12) carries the other record's values survivor-first and only for fields that
  still exist (0141).
- The register line stays L-5.
