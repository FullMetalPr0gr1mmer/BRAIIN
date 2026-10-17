# F5b: the rest of the field kit — accent, link, slugRelation, clip v2 and the built-ins

- **Lane:** UI, Wave 2 (F5's second half, decision D1; [F5a](F5a.md) is the first)
- **Design:** [ui.md](../ui.md) §2.6 "Field kit v2" (accent, link, slugRelation, clip v2,
  sectionContent), §1.6, §2.11, §10, AV-08 (the F5b half); README P-1, P-10, P-12
- **PR:** not opened yet (branch `feat/f5b-field-kit-rest`)
- **Migrations:** none. No capability, no §5 change, no nav change, no new screen. Public
  output byte-identical (the F6 render snapshots pass unchanged).

## What was built

- **One tokeniser for the page and the form.** `accentTokens` in `src/lib/text/accent.ts`
  is now the single step that turns a heading into words; `splitAccent` builds its runs
  from it and `src/lib/admin/accentWords.ts` counts, clamps and previews with it, so "from
  word 3" means the same word in the editor and on the page. `clampAccent` holds a stored
  range inside a heading that has shrunk and inside `AccentSchema`'s own bounds, so the
  field never offers a range the server would refuse.
- **`accent`** (`fields/AccentField.tsx`): per language, "Highlight from [word] up to
  [word]", with "No highlight" and a live preview of the result. One control set for both
  ways of storing it — its own key (`AccentSchema`) or the two numbers beside the heading
  (the hero and the slogan band's `accentFromEn` / `accentFromAr`, `AccentDef` mode
  `from`) — and the payload is a word range, never markup (Pillar 1). The mode-`from`
  field is the one kind whose payload is a SPREAD into its parent's keys, in
  `objectToPayload` and `formToPayload`.
- **`link`** (`fields/LinkField.tsx`): the words in both languages plus where it goes. A
  picker of the pages this site HAS writes into a box that always shows the value, so a
  target the list does not hold (an anchor, a page since unpublished) is visible rather
  than hidden behind "nothing chosen", and the server render is the same as the hydrated
  one. Picking a page fills both labels when they are empty and never overwrites words
  already written. What the box accepts is the rule the server enforces.
- **`src/lib/admin/linkables.ts` and `GET /api/admin/linkables`**: `CODE_ROUTES` (every
  CMS page path from `PAGE_PATHS`, the blog index, the three legal notices, the anchors
  code renders) plus, through the caller's own client under RLS, each published page's own
  title and every published service and project — bounded, published only, three small
  sequential reads. `isSiteHref` is the client's copy of `SafeHrefSchema` and
  `tests/lib/linkables.spec.ts` holds the two equal on a table of inputs (`//host`,
  `javascript:`, `/a/../b`, an over-long path, a non-string); `isHttpsHref` refuses `http:`
  and credentials. The route is `defineAdminRoute` with `anyCap` over everyone who edits a
  field holding a link; its case row is `tests/authz/cases/linkables.ts`.
- **`slugRelation`** (`fields/SlugRelationField.tsx`): an ordered pick stored by slug, on
  `useOptions`, which now honours `relation.valueKey`. A slug the picker does not offer
  keeps its place: removing it has to be a decision.
- **`src/lib/media/clips.ts`**: `SITE_CLIPS`, the site's own video files and their lengths,
  held to the files by `tests/lib/siteClips.spec.ts`, which reads each one's `mvhd` box
  with a byte read (no new dependency). Wave 3's U4 consumes this registry.
- **clip v2** (`fields/ClipField.tsx`, rewritten onto FieldShell): the file is picked from
  that registry, the window reads as "6.2 s to 7.9 s of showreel.mp4 (18.4 s)" on an
  `aria-hidden` SVG timeline, and a window past the end of the video or past the 30 s rule
  is said in words before the save is refused.
- **Section content as differences** (`fields/SectionContentField.tsx`,
  `omitBuiltIn` in `formPayload.ts`): with the section's built-in copy in hand, a field
  shows those words under anything stored, nothing is stored for a field left at them, and
  a key group the renderer reads together — an accent and the heading whose words it
  counts — is stored whole or not at all. The groups are DERIVED from the fields
  (`accentGroups` in `sectionUi.ts`), because the built-in COPY must not ship in the admin
  bundle (F6); `tests/lib/sectionUi.spec.ts` holds them against F6's own `together`. One
  button puts every field back. A bilingual field whose English was changed while its
  Arabic is still the built-in's says "Arabic still shows the built-in text."
- **"Advanced (JSON)" is an Admin's** (D5): offered on `content.archiveDelete`, passed from
  the two sections pages, so no screen compares roles by name. A section already holding
  raw JSON still shows it to everyone — hiding it would hide content nobody could clear.
- **`SECTION_ADVANCED_ONLY` is `{ hero: ['intro'] }`.** Every accent is a typed word range,
  `selectedWork.cardSlugs` a slug list over published featured projects,
  `selectedWork.button` a link and `testimonials.intervalMs` a slider. `hero.intro` stays
  JSON-only: it is a ROUTE decision (`withHomeIntro`), and an unticked box would read as
  `intro: false`.
- **Errors**: `fieldErrors.ts` maps an accent's two pickers per language, a link's words
  and its address, and — in section content — an accent stored under its parent's two keys
  back to the one field that writes them.

## The exported API (frozen at merge)

As the brief's §4, with these additions (nothing in it was removed or renamed):

- `formPayload.ts`: `AccentFormState` and `LinkFormState` (the two form shapes),
  `accentState`, `linkState`, `linkIsBlank`, `linkHrefOk` (what a link field accepts, so
  the component and the payload cannot disagree), `accentToRanges`, `accentFromKeys`, and
  `omitBuiltIn(content, builtIn, fields, together?)` — the fourth argument is the groups
  (see the departure below).
- `SectionContentState` gains `builtIn?: Row` and `together?`: the built-in copy travels
  with the state, written on the first change the field makes, so the payload can drop
  what equals it without a render ever marking a form dirty.
- `sectionUi.ts`: `accentGroups(fields)` and `contentKeysOf(field)`.
- `accentWords.ts` also exports `accentPreview(text, range)` (the field's preview line).
- `RenderField` takes an optional fifth argument, `{ values?, builtIn? }`: the object a
  nested field sits in (an accent reads the sibling its `accent.of` names) and the
  built-in value under it. `FieldComponentProps` gains `values?` for the same reason.
- `ResourceFormProps` gains `canAdvanced?`.
- `fields/ClipField.tsx` and `fields/SectionContentField.tsx` keep their default exports
  and their element ids; ClipField's two number boxes gain `data-label` (EditorForm names
  a box the browser could not read by it).

## Departures from the design, and why

- **D4 taken: the built-in prefill is plumbing here, not wiring.** The design offers the
  fallback if computing the look needs more than two bounded reads. It needs more than
  that: the sections item GET is `itemRoutes(sectionResource)`, the shared CRUD kernel,
  whose only per-resource shaping hook (`fromRow`) is synchronous — reading the page's slug
  and whether an earlier section of the same type exists is asynchronous, so wiring
  `built_in` means changing the kernel every resource goes through, which Wave 2's common
  brief rules out ("add files plus one registry line; do not reorganise shared files"). So
  the `builtIn` prop, `omitBuiltIn`, the prefill, the Reset button and the stale-translation
  note are built and unit-tested, and **nothing passes a built-in yet**: no save changes
  shape today. E1 has the page context and wires it with one prop.
- **The `builtIn` prop's contract is "already stripped".** F6 marks some fields
  `notVerbatim` — their built-in value is not what the page renders from a stored one (it
  names the studio through `%brand%`, or bolds a run). Prefilling one would store
  something other than what is shown, so the screen that supplies `built_in` leaves those
  keys out, rather than the client learning F6's declarations (which would pull the copy
  into the admin bundle). Stated in the component's header.
- **`together` is derived, and is one group wider than F6's.** The admin cannot import
  `SECTION_COPY`, so `accentGroups` derives the groups from the fields: an accent and the
  text it counts, every time. F6 declares a group only where storing one of them ALONE AT
  ITS BUILT-IN value already changes the page, which is not true of the slogan band (it
  reads its accent whether or not the text is authored). The editor stores the slogan's
  text and its accent together anyway: the range it shows is the built-in's, counted
  against a text the editor may have changed, so storing what is shown is the honest save.
  `sectionUi.spec.ts` pins that this is the ONLY difference, so a drift is not mistaken
  for a new case.
- **Reset is one button for the section, not one per field.** ui.md says "plus 'Reset to
  built-in'" without saying where. Per-field would need a control inside FieldShell, F5a's
  shared seam, and would change the chrome of every kind in the kit.
- **The link picker loads on first reach, not on mount.** Three reasons: a form with
  several link fields spends no subrequests until one is used (the Worker's Free plan
  allows 50); `/admin/kit` keeps the property its sweep entry states, that the screen reads
  nothing, for every role; and SEO — which §5 gives no field holding a link, so the
  endpoint refuses it — never meets a refusal on a screen it may open. A load that fails is
  a note, not an alert: the box still works.
- **The link picker and the box are both always shown.** The design says "a custom link
  must be site-relative or https", implying a second mode. A mode would have to be guessed
  before the targets load (they are fetched after mount), so the server HTML and the
  hydrated DOM would disagree and a stored anchor would look like "nothing chosen" until
  the list arrived. Both controls, always: the picker writes, the box is the value.
- **`link` is site-relative unless `link.external`** (D3, unchanged from the design): the
  only content schema with a button uses `SafeHrefSchema`. The client rule equals the
  schema the field writes to; the server stays the gate.
- **The legal notices' labels in `CODE_ROUTES` are literals**, held equal to the notices'
  own titles by `linkables.spec.ts`, rather than imported: `src/lib/legal/content.ts` is
  16 KB of notice copy and a link field ships in the admin bundle.
- **`/admin/kit`'s slug list names no resource.** The sample field has no `relation`, so
  the screen still reads nothing; `useOptions` now stops "loading" when there is none
  (which also fixes a relation-less RelationField sitting disabled for ever). The field
  draws its list, its order and its buttons, which is what the sweep and axe check.
- **No new contrast pair.** The accent preview's highlighted words are `--ad-primary` on
  `--ad-bg` and the clip's window is `--ad-primary` on a card: both pairs the gate already
  audits (9.83 and 10.61). Forced colours give each a system colour, because in the preview
  and the timeline the colour IS the cue.

## The bundle (P-10)

`accentWords` and `linkables` joined the `admin-fields` group (`astro.config.mjs`), so the
new code rides only on a screen with an editor. Measured with `npm run size` on this
machine (gzip, KB = 1,000 B):

| | main (`73f206b`) | F5b |
|---|---|---|
| Screens without an editor (Applications, Chrome, Leads, Logs, Maintenance, ResourceTable, Users, Visibility) | 118.4 to 118.5 KB | 118.5 to 118.6 KB |
| Editors (`AdminResourceForm`, `AdminSingletonForm`) | 140.7 KB | 146.1 KB |
| `/admin/kit` (`AdminKit`) | 145.3 KB | 151.0 KB |
| `admin-rich` (lazy, ≤ 140 KB) | 122.6 KB | 122.6 KB |
| Sign-in script | 0 KB | 0 KB |
| size-limit admin sum (≤ 300 KB) | 266.25 KB | 271.90 KB |
| size-limit public (≤ 100 KB) | 25.51 KB | 25.51 KB |

Four field kinds, a code registry and the built-in plumbing for +5.4 KB on an editor and
+0.1 KB on every other screen; 146.1 KB against P-10's proposed 300 KB per screen.

## Tests

- Unit: `accentWords.spec.ts` (the words are the renderer's own, including Arabic digits
  and a footnote mark; every clamp lands on a range `AccentSchema` accepts),
  `siteClips.spec.ts` (each duration against the file's `mvhd`), `linkables.spec.ts`
  (`isSiteHref` ≡ `SafeHrefSchema`, `isHttpsHref`, `CODE_ROUTES`, `loadLinkables`'s
  filters, bounds, de-duplication and its behaviour when a table cannot be read);
  `adminFields.spec.ts`, `formPayload.spec.ts`, `fieldErrors.spec.ts` and
  `sectionUi.spec.ts` extended for the four kinds, `omitBuiltIn`, the prefill, the
  stale-translation note and the Admin-only Advanced box.
- Endpoint cases: `linkables` over the six principals (allow admin, content creator,
  developer; deny SEO, anon, other tenant), with its manifest line.
- e2e (CI): `tests/admin/kit.e2e.ts` drives the accent, the link picker, the clip window
  and the slug list as admin, with axe over them; `tests/admin/fields.e2e.ts` opens a
  seeded section and checks, per role, that the accent is word pickers counting the
  heading's own words and that "Advanced (JSON)" is the Admin's — read-only, because those
  rows are the public pages'.
- Render: F6's byte snapshots unchanged (the tokeniser moved; the output did not).

## Help guide

No new screen, so no guide and no migration (brief §8). As F5a recorded, the next slice
that restates the help set may add a line about the English / Arabic / Both switch and the
"Arabic missing" cue; it may now also say that a section's fields start as the words the
page already shows, and that only what you change is stored.

## Owner questions

- **The slogan band's accent** is the one place where the editor stores a group F6 does
  not declare (above). The alternative is to leave the stored accent pointing at word 4 of
  a text the editor has just rewritten. Say if the studio would rather it did.
- **SEO and link targets.** `GET /api/admin/linkables` refuses SEO, per the design, because
  §5 gives SEO no field holding a link. If redirects ever grow a "pick a page" control for
  their target path, that decision reopens.
