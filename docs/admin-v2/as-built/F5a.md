# F5a: the field kit v2, `useEntitySave` and the Arabic-digit guard

- **Lane:** UI, Wave 2 (F5 is split, decision D1: F5a here; F5b, the accent, link and
  slugRelation kinds, `GET /api/admin/linkables`, clip v2 and the built-in plumbing, is a
  later PR)
- **Design:** [ui.md](../ui.md) §2.6 "Field kit v2", §1.6, §2.11, §10, AV-08 (the F5a half);
  README P-1, P-5, P-10, P-12; [verification.md](../verification.md) "Details the designs
  missed" (Eastern Arabic digits)
- **PR:** not opened yet (branch `feat/f5a-field-kit`)
- **Migrations:** none. No capability, no §5 change, no nav change, no new screen.

## What was built

- **The save.** `src/lib/admin/entitySave.ts` is the editor's save as a pure state machine
  (`initialSaveState`, `entitySaveReducer`, `buildSaveRequest`), carrying the rules
  ResourceForm and SingletonForm each held on their own: the version sent back and its 409,
  a datetime the editor did not touch left out of the PATCH, a singleton never saved sending
  version 0, the form re-seeded from the server's row, `kvSynced` false shown as the edge
  warning (and `?edge=missed` across the create). `src/lib/admin/useEntitySave.ts` is the
  hook over it, the one place that knows the save mode (`saveModeFor` in `saveMode.ts`
  answers `live`; `mode: 'draft'` throws "Draft saving arrives with releases (R12)"):
  it loads, saves, keeps the editor's work on a 409 for "Reload their version", lands a
  422 on the fields, guards `beforeunload` while dirty, and `useSaveShortcut` saves on
  Ctrl/⌘+S.
- **The errors.** `src/lib/admin/fieldErrors.ts` maps the kernel's `issues[].path` to the
  form's element ids by walking the declared fields (a bilingual pair's whole-object error
  lands on its English input, a rich-text error deep in its document on that language's
  editor, a repeater item's or an object's sub-field on its input, section content by the
  sub-field's name), names each in words ("Service name (Arabic): Required", "Value we add
  2, Text (English): Too long") and lists a path that names nothing without a link.
  `errorsFromApi` also reads the one `field` a mapped constraint names (a taken slug).
- **`EditorForm`** (`src/components/admin/fields/EditorForm.tsx`) draws every editor the same
  way: the ErrorSummary first, a line for a refusal that is not about one field, the 409
  banner, the language bar when any field has an Arabic half, the screen's own notes
  (children), the fields, and the action bar (Save, the way back, SaveStatus, "Version N" or
  "Not saved yet"). **ResourceForm and SingletonForm** are now a few lines each on
  `useEntitySave` and `EditorForm`, their requests and rules unchanged
  (`tests/lib/entitySave.spec.ts` holds the rules, `singletonFirstSave.spec.ts` and
  `resourceSync.spec.ts` pass unchanged).
- **The field kit** (`src/components/admin/fields/`): `FieldShell` (the label row with meta
  on its right, the required star seen and the word "required" heard, the hint and the
  inline error by `aria-describedby`, `aria-invalid` on the control); `BilingualField`
  (bilingual and prose: both inputs in the DOM, the other `hidden`, the field's own EN | AR
  switch as a kit Segmented named "<Label> language", the Arabic half `lang="ar"
  dir="rtl"`, "Arabic (missing)", prose's "Arabic not written yet"); `editorLanguage.tsx`
  (English / العربية / Both for the whole form, remembered in `admin:editLang` with every
  storage access guarded, D6; the gaps registry, "Arabic missing: N" and "Next gap");
  `SwitchField` (a checkbox as `button role="switch" aria-checked`, named by its label, which
  also toggles it); `ColorField` (the native picker, the hex as monospace upper-case text,
  swatches as `aria-pressed` buttons painted by an SVG `rect fill`, the contrast line in
  words from `src/lib/admin/contrast.ts`); `RangeField` (a slider and its `<output for>`
  with the suffix); `ChipsField` (`chips`, and `tags` drawn the same way: "Remove tag x",
  Enter or a comma adds, leaving the box adds too, "At most N", a bilingual set as two
  lists); `RepeaterField` v2 on the kit's Sortable (handle, Move up and down, collapse,
  "Remove <label> N", "At most N", the item titled by its own first words); `MediaField` v2
  (a tile: thumbnail, name, Choose or Change, Remove, the alt badge "No Arabic alt" or "No
  alt text"; the picker's grid as it was, upload is U4's); the rich-text bar restyled
  (`.rich`) with a link dialog on the kit Modal (`LinkDialog.tsx`), still lazy in
  `admin-rich`; `reveal.ts` (a request to show a field that is on the form but out of
  sight). `ErrorSummary` (kit) reveals before it focuses (on the next frame).
- **Values** (`src/lib/admin/fieldValues.ts`): `normalizeHex`, `clampToStep`, `cleanChips`,
  `splitChips`, shared by the components and `formPayload.ts`, which now shapes `color`
  (uppercase `#RRGGBB`; blank is null at the top, omitted inside jsonb; anything else sent as
  typed so the server names the field), `range` (held to its bounds and step) and `chips`
  (trimmed, deduped; a bilingual set as `{en, ar}` lists, omitted inside jsonb while both are
  empty). `tags` are deduped on save too.
- **CSS:** app.css 160-230 ported into admin.css's Forms and Composite fields blocks with a
  class layer and ARIA-state selectors, tokens only; the contrast gate gains the new non-text
  pairs (the "missing" dot on a segment, the switch knob on both tracks, a chosen swatch's
  ring). Forced colours: the dot is `Mark`, a pressed swatch and a chip get a border.
- **`/admin/kit`** gains a "Fields" card: every kind on made-up values in the editor's
  language context, with a pretend refusal whose errors land on the fields (one in the hidden
  Arabic half), so the per-role sweep checks each kind (axe, CSP, no style attribute, no
  overflow).
- **Tests:** `fieldErrors.spec`, `entitySave.spec`, `contrast.spec` (equal to
  `scripts/contrast-audit.mjs`, whose three functions it lifts from the script's source),
  `editorForm.spec`, `arabicDigits.spec` (with its source scan) and
  `tests/render/arabicDigits.spec.ts`; `adminFields.spec` and `formPayload.spec` extended;
  `adminBundle.spec` holds the new chunk group; e2e in `tests/admin/kit.e2e.ts` (the Fields
  card) and `tests/admin/fields.e2e.ts` (a seeded service: the digits round trip as admin and
  content creator, the 409 in a second tab).

## The exported API (frozen at merge)

As the brief's §4, with these additions (nothing in it was removed or renamed):

- `EntitySave.message: string | null`: why the last save was refused when it is not about
  one field (a 403, a rate limit, a JSON box that does not parse). A defect in the brief's
  interface: the state had it, the hook's return did not, so EditorForm could not say it.
- `EntitySaveAction`'s payloads: `loaded` carries `{ row, fields, versionFallback }` and
  `saved` carries `{ row, fields, at }`, so the reducer stays pure (no clock, no config).
  `entitySave.ts` also exports `versionFallback(target)` (a collection row 1, a singleton 0),
  `isDirty`, `loadUrl` and `createdHref`.
- `useEntitySave` takes its options as `UseEntitySaveOptions` (the brief's shape, named).
- `FieldShellProps.inline` (the switch beside its label), and `Required` (the star and word).
- `SegmentOption.cue` on the kit's Segmented: words read after the label, shown as a dot
  (the "Arabic (missing)" name). Additive; no Segmented call site changes.
- `editorLanguage.tsx` also exports `useFieldLanguage(ids)` (a field's own EN | AR choice
  over the editor's), used by the bilingual, chips and rich-text fields.
- `reveal.ts` also exports `revealAndFocus(id)`, used by ErrorSummary and "Next gap".
- `fieldValues.ts` is where `normalizeHex` and `clampToStep` live; `ColorField` and
  `RangeField` re-export them as the brief names them, so `formPayload.ts` imports no
  component.
- `contrast.ts` also exports `contrastVerdict(ratio)` ("passes AA", "passes AA for large text
  only", "fails AA").
- `fieldErrors.ts` also exports the `ApiIssue` and `MappedErrors` types.
- `fields/LinkDialog.tsx` (new; `RichText` takes it as its `linkDialog` prop), `MediaField`'s
  `altGap`, `RepeaterField`'s `itemTitle`.

## Departures from the design, and why

- **Two e2e files.** The Fields card's tests are in `tests/admin/kit.e2e.ts` with the kit's
  others; the editor round trip and the conflict, which save to the database, are in
  `tests/admin/fields.e2e.ts` (the brief's name). Each role works on its own seeded service
  (`letterhead`, `stationery`) and the conflict on a third (`packaging`), so parallel workers
  never race a version; the title is put back after the digits test.
- **The AR option reads "Arabic", not "AR".** Its accessible name becomes "Arabic (missing)"
  (ui.md), and WCAG 2.5.3 needs the visible label inside the name: "AR" is not. So the
  field's switch reads English | Arabic; the editor-wide one English | العربية | Both.
- **What counts as "Arabic missing".** A `bilingual` pair that is required, or whose English
  is written (the server refuses a half pair), with its Arabic empty. ui.md says "required";
  an optional pair with English and no Arabic fails the save just the same, so it is a gap
  too. A blank optional pair is not. `prose` lags in a neutral line, never counted.
- **Rich text.** The bar keeps the buttons it had (quote, code block, rule) beside the
  design's B, I, H2, H3, lists, link and clear. Each button's words are its name ("Bold",
  "Italic": WCAG 2.5.3, as before), the rule's "—" glyph became "Rule" (P-12). The link
  dialog accepts what the public renderer draws (`sanitizeHref`: http, https, mailto, tel,
  a path on this site), so it never accepts a link the page would drop; StarterKit's Link is
  set not to open on click. The dialog reaches RichText as a prop, not an import: RichText is
  the lazy `admin-rich` chunk, and a shared module it imported would be pulled into it, after
  which every screen using that module would load the editor eagerly.
- **A failed load shows the error, not a blank form.** Before, an edit screen whose GET
  failed rendered empty fields that could be saved over the row it never read.
- **The save line.** The "Saved." banner is SaveStatus ("Saved at 14:05"), and Save is
  disabled while a save is on its way. A select's empty option reads "Not set" (was "—",
  P-12). The repeater's empty line is "None yet." (it said the section's built-in copy shows,
  untrue for a service's value cards, and had a dash).
- **Ctrl/⌘+S** saves a form with changes only, and on a page with two editors (General
  settings) the one focus is in.
- **The repeater's moving name.** The handle, the Move buttons and the announcements name an
  item by its own words ("Brief lifted, position 1 of 3"), which a move does not change;
  "Step 2" follows its place. "Remove <label> N" keeps its old words ("Remove value we add 2").
- **Not restyled in F5a:** RelationField, ObjectField, ClipField, UploadField and
  SectionContentField keep their markup (`.field`); clip and section content are F5b's, the
  others are not in AV-08's list. Their pins (`Page *`, `Rating line *`) are unchanged.
- **mapIssues and section content.** `mapIssues(issues, fields, idPrefix?)` has no form values,
  so a section content path's sub-field is found by its name across `SECTION_UI` (the same
  name has the same label in every type that has it).
- **Two test pins moved with the markup, neither weakened.** The "every field renders with
  unique ids" check now renders a form's fields in one React root, as EditorForm does: the
  repeater's Sortable instructions carry a `useId()` id, unique per root, and separate roots
  each start the same sequence. `adminKitReact.spec` counts the gallery's dialogs and live
  regions with the Fields card's media picker and repeater (4 and 4).
- **The source scan's allow-list** names three files, not one: `src/lib/crm/normalize.ts`
  (NFKC and digit folding for the phone blind index only), `src/lib/crm/leadQuery.ts` (a
  searched term read as a phone number for that lookup) and `src/lib/admin/palette.ts` (NFKD
  for the command palette's matching). None changes a stored or shown value; a stale entry
  fails the scan.
- **The link label round trip** (brief §9) is F5b's: the `link` kind does not exist yet. The
  other layers are all held: Zod (LocalizedText, the statistics section content, the services
  and statistics create schemas), the form (bilingual, prose, repeater items, chips), the
  resources' `toRow`, the Tiptap gate, renderer and plain text, the accent tokeniser, and the
  render project.

## The bundle (P-10, D9)

In `admin-ui` the field kit rode on every admin screen (each screen's eager graph 113.5 to
125.6 KB gz in the first build). It is now its own group, `admin-fields` (`ADMIN_FIELDS` in
`astro.config.mjs`: FormField, `fields/`, `formPayload`, `sectionUi`, `fieldErrors`,
`fieldValues`, `entitySave`, `useEntitySave`, `saveMode`, `contrast`, ResourceForm and
SingletonForm), priority 15: below `admin-ui`, so what both use stays there, and above
`admin-kit`, so the kit pieces the fields draw with come with them. `admin-ui` also leaves the
two editor islands alone: its path rule matched their entry modules, and a group takes its
modules' static dependencies, so it had taken the whole field kit along (the first try
produced no `admin-fields` chunk at all). `tests/lib/adminBundle.spec.ts` holds the claims and
that no module `admin-ui` claims imports one of `admin-fields`.

Measured with `npm run size` (gzip, KB = 1,000 B):

| | main (`23ce829`) | F5a |
|---|---|---|
| Screens without an editor (Applications, Chrome, Insights, Leads, Logs, Maintenance, ResourceTable, Users) | 113.4 to 113.5 KB | 104.4 to 104.5 KB |
| Editors (`AdminResourceForm`, `AdminSingletonForm`) | 113.5 KB | 126.9 KB |
| `/admin/kit` (`AdminKit`) | 122.1 KB | 132.0 KB |
| `admin-rich` (lazy, ≤ 140 KB) | 122.2 KB | 122.6 KB |
| `admin-fields` chunk alone | (none) | 21.6 KB |
| Sign-in script | 0 KB | 0 KB |
| size-limit admin sum (≤ 300 KB) | 242.66 KB | 252.93 KB |
| size-limit public (≤ 100 KB) | 25.51 KB | 25.51 KB |

The ledger (ui.md §2.11) estimated +6 KB for the fields; the editors pay +13.4 KB, the field
kit (21.6 KB with the kit pieces it draws with: Segmented, Modal, the Sortable core) less the
old forms' code that left `admin-ui`. Every other screen is 9 KB lighter than on main.

## Help guide

No new screen, so no guide and no migration (brief §8). The "saving-and-publishing" guide
(0046) stays true. The next slice that restates the help set (U1 or U2) may add one line about
the English / Arabic / Both switch and the "Arabic missing" count.

## Owner questions

- **The editors' weight.** 126.9 KB eager against P-10's proposed 300 KB per screen, +13.4 KB
  where the ledger guessed +6. Input for O-15; L1 (an explicit Tiptap extension set) is still
  the lever for `admin-rich`, which is lazy.
- **Leaving with unsaved changes** now asks the browser's "Leave site?" question on every
  editor (D7). Say if the studio would rather not.
