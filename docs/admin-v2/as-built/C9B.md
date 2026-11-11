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

Status: building (2026-11-11).

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
