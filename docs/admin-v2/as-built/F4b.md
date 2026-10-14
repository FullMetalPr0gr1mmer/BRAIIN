# F4b: the component kit

- **Lane:** UI, Wave 1 (F4 is split: [F4a](F4a.md) was the bundle plan)
- **Design:** README "Slice sequence", F4 [AV-07]; [ui.md](../ui.md) AV-07, §1.6, §2.3 to
  §2.5; F1, F3 and F4a's hand-offs to F4
- **PR:** not opened yet (branch `feat/f4b-component-kit`)
- **Migrations:** none

## What was built

- **Server primitives** (`src/components/admin/ui/`, Astro, zero JS): Card (F1's header band
  for a title alone, the prototype's `.card__h` with a sub-line or actions), Badge (a tone or
  a content status, always a word), Avatar, Kpi (the figure, the change against the previous
  period as a pill whose glyph is hidden and whose words are read, a spark), Note, EmptyState,
  Timeline (an `<ol>` of `<time>` entries), StatRows (a `<dl>`), ListRow, LinkTabs (PageHead's
  area tabs now render through it), LinkChips, Pager and ServerTable (typed cells: text,
  number, status, date, date and time, "3 h ago"), BarList.
- **Charts** (`ui/charts/`): Spark, Line, BarsV, Donut and Ring, server-rendered SVG with no
  chart library and no style attribute. The geometry is pure functions
  (`src/lib/admin/charts.ts`: a round y scale, at most eight x labels, 5% bar buckets,
  shares that add up to 100). Each chart but the decorative spark and the one-value ring sits
  in ChartFigure: a caption, the drawing as `role="img"` named by the caption and a one-line
  summary, a legend, and "View as table". The summary and the table are built from the same
  data as the drawing (the AV-07 risk): a line chart's series are cut once to the points it
  draws (`drawnSeries`), which feed the drawing, its scale, its table and its summary, and
  `tests/astro/primitives.spec.ts` compares the table cell by cell with the data.
- **React kit** (`src/components/admin/kit/`): DataTable (server paging with "26 to 50 of 112"
  in a live region and numbered pages, a page emptied past the end stepping back to the last
  page with rows, the title a real link stretched over its row, opt-in selection with
  labelled checkboxes, a tri-state "Select all on this page" and the midnight bulk bar, the
  selection being the page's (below), row actions on hover and whenever focus is in the row,
  click-through while hidden, loading, empty and error states), Pager, Tabs (ARIA tabs, roving tabindex, mirrored arrows in a right-to-left block,
  `?tab=` kept by `replaceState` and read by the server for the first paint, panels kept
  mounted), Segmented, Chips, StatusBadge, SaveStatus, ErrorSummary, Modal and Drawer (light
  dismiss only for a press made on the backdrop, below), and the React twins of Avatar,
  EmptyState, ListRow and Note.
- **The Sortable core** (`src/lib/admin/client/sortable.ts`): a pure state machine (lift,
  step, shift to another list, place, drop, cancel, the one-click moves; each returns what to
  announce and what to save) and a DOM binder for keyboard, pointer and Move buttons, with a
  live region. `kit/useSortable.ts` binds it to a list React renders (the binder hands each
  order to `apply`, which re-renders with `flushSync`); `kit/Sortable.tsx` is the handle, the
  Move buttons, the hidden instructions and the live region (SortHint renders it beside the
  list, so a list in a Modal or Drawer is heard: a region on the body is inert while a modal
  dialog is open; a vanilla list in a dialog gets its fallback region inside that dialog).
  The Move buttons' `aria-disabled` follows any reorder, the owner's re-renders included (a
  MutationObserver on the root), not only the binder's own moves.
- **Shared models**: `relTime.ts` (Asia/Riyadh, en-GB: "just now", "5 min ago", "3 h ago", "2
  d ago", then the date; "in 5 min", "tomorrow"), `avatar.ts` (the tone hash), `pager.ts`,
  `roving.ts`, `kpi.ts`, `tones.ts`.
- **ResourceTable on DataTable**, its props, state and requests unchanged (below).
- **`/admin/kit`**, every piece on made-up data (below), and its screen sheet `kit.css`.
- **Tests**: `charts.spec`, `sortable.spec`, `relTime.spec`, `avatar.spec`, `adminKit.spec`
  (the pure models), `adminKitReact.spec` (the React kit's markup, ARIA and words),
  `tests/astro/primitives.spec.ts` and `kitParity.spec.ts` (vitest's new `astro` project,
  `vitest.astro.config.ts`, renders `.astro` files through Astro's container API),
  `tests/admin/kit.e2e.ts` (CI), and `resourceSync.spec` unchanged. Every render in the unit
  and container specs is also checked for a style attribute.

## Departures from the design, and why

- **A reference screen, `/admin/kit`.** Not in AV-07. F1, F3 and F4a held that no kit piece
  ships without markup to check it against, and AV-07 asks for "axe on screens using the kit"
  while most pieces have no screen until U1, U2 and the CRM. The page renders every server
  primitive and chart, and the `AdminKit` island every stateful piece, on made-up data (its
  content reads nothing and saves nothing; its shell, AdminLayout, reads what every
  screen's does: the identity, the menu's counts, the bell, the environment and
  maintenance). It is in the sweep's extras (`tests/admin/routes.ts`), so
  every role's visit checks each piece for axe, the CSP, a style attribute in the server HTML,
  console errors and overflow; `tests/admin/kit.e2e.ts` drives the Sortable core (keys,
  Move buttons, pointer, across lists), the tabs and their address, the table's selection,
  bulk bar, pages and chips, the dialogs' focus and the error summary, and runs axe with a
  dialog open and every chart table showing. It is not in the menu: a page for the people
  building screens, reached by its address. Its island's code is kept out of every other
  screen's bundle (below).
- **ResourceTable.** "Re-implemented on DataTable with its props and hooks kept": the props,
  the state, the list, delete, reorder and sync requests and `EDGE_NOT_SYNCED` are as they
  were. What a person sees changed with the kit: the first column's text is the link to the
  edit screen (no separate Edit button); Move up, Move down and Delete are icon buttons named
  for their row ("Delete Logo design"), shown on hover and focus (Delete still renders for
  every role; the server's 403 is the gate, as the comment there says); the status filter is
  chips instead of a select; statuses are words ("Published", not "published"); a date is the
  Riyadh calendar date (it was the browser's locale and zone: one clock for every screen,
  whoever's browser shows it; the rows are fetched after mount, so this was never a
  hydration mismatch); the empty state says whether nothing exists or nothing matches. The
  delete confirmation names its row ("Delete the service “Logo design”?", the name a bidi
  isolate), since the trigger became an icon. A bilingual title with no English is its
  row's link in Arabic (`lang="ar"`, WCAG 3.1.2) and the line under it says only "no
  English"; the "no Arabic" cue is no longer marked as Arabic text.
- **Modal and Drawer** (F3 handed them to F4). F8 merged first with the shell's own drawers
  (`screens/chrome/ChromeDrawer.tsx`) and the `.drw`, `.list`/`.li` and `.empty` rules. The
  kit builds on those instead of repeating them: the Drawer is F8's markup (`.drw__panel`
  filling the dialog), `useDialog` applies F8's focus-return rule (`focusReturnTarget`: when
  the opener is gone, the Menu button), and the kit's CSS only adds what F8 lacked (a stretched
  title link in a row, a row's actions, the current and hidden rows, the empty state's
  title, line and action, the modal, the wide drawer, the right-to-left entrance).
  ChromeDrawer is not converted (no slice converts screens it does not own); the kit's Drawer
  can replace it unchanged.
- **Light dismiss needs a press on the backdrop.** Modal and Drawer close on a backdrop
  click by default, as F8's drawers do, but only when the pointer went down and came up on
  the backdrop (`backdropDismiss` in `useDialog.ts`). A press that starts in a field
  (selecting its text) and is let go over the backdrop is dispatched as a click on the
  `<dialog>`, the common ancestor, and closed it under the person's hands. A click with no
  press behind it (the keyboard, assistive technology) never dismisses; Escape and Close
  do. `dismissible={false}` stays the advice for a form.
- **A selection is the page's.** ui.md §2.4 draws the bulk bar but not what a selection
  spans. DataTable counts and acts on the ticked rows on screen only, clears the selection
  on a new page, and keeps only the ticked rows still shown after a filter, a search or a
  delete: a bulk delete or publish (Media, Redirects, Projects, Testimonials) never reaches
  a row the person cannot see. A screen that needs "all 112 matching" later adds it as its
  own, said action.
- **Hidden row actions are click-through.** The prototype hid row actions with opacity
  only; above the stretched row link they still took presses, and ResourceTable's Move
  posts at once. They take no presses while hidden (`pointer-events: none`), and hover
  arms them only once faded in (a 0.2s delay on the pointer-events transition): a tap on a
  touchscreen laptop applies `:hover` and hit-tests again in the same gesture, so arming at
  once still handed the tap to the button it revealed (checked in Chromium). The cost: a
  click within 0.2s of the pointer entering a row goes to the row's link, not the action
  under it. Focus and a tick arm them at once, except while a hover's 0.2s is already
  running (the transition ends to the same value, so it is not restarted, checked in
  Chromium); the keyboard reaches them as before, and reduced motion keeps the delay,
  which is not motion. A ListRow's actions (`.li__acts`) follow the same rules: they too
  sat above a stretched title link.
- **A KPI with no previous period draws no change pill**, where ui.md §2.4 shows "—".
  `kpi.ts` returns no change, and Kpi draws nothing: an absent trend reads better than a
  placeholder, and the admin copy has no dashes (P-12).
- **Not built: the `[data-confirm]` enhancer for server forms** (F3 handed it to F4 with its
  first screen). No server form asks for a confirmation yet; `confirm.ts` serves the islands.
- **Avatar tones.** The prototype hashed the name into seven hex colours, three under 4.5:1
  behind white initials, set with a style attribute. Here the hash (the prototype's own) picks
  one of eight audited `--ad-tone-*` tokens through `data-tone`, keyed by the person's id, so
  a rename does not recolour them. `initialsOf` moved to F8's `src/lib/admin/initials.ts`
  (both slices moved it; F8 merged first) and now cuts by code point, so an Arabic or astral
  first letter is never halved.
- **Charts.** Series are classes on the audited series tokens, the second dashed and the third
  dotted, so colour is never the only cue; no value lives only in a hover title (the
  prototype's), the table has them all. A one-point series is a dot, and no data is said in
  words instead of an empty frame. Forced colours paint the strokes in CanvasText.
- **Segmented** is native radios in a fieldset (the legend names the group; the browser owns
  the arrows and the checked state), not the prototype's buttons with an `.on` class. Tabs
  wear the same look.
- **Sortable.** The prototype's `.drag` was an 18px glyph; the handle is a 44px button
  ("Reorder Hero", described by the instructions), and every item also carries Move up and
  Move down (and, across lists, to the previous or next list) buttons, always present, marked
  `aria-disabled` where they would go nowhere (still focusable, so pressing one says why
  nothing moved). A drag is heard on the document once a handle is pressed: reordering moves
  the dragged element, which releases its pointer capture. `useSortable` ends its preview when
  a move ends where it began, so the list follows its owner's order again.
- **Grid modifiers** (`.grid--2/--3/--4`, `--2-1`, `--1-2`, `--3-2`, which F1 moved here) give
  way by the space each column would get, not by a container query: a query container on the
  main column would become the containing block of every fixed-position box inside it.
- **KPI markup** puts the label before the figure, so it is read "Visits, 3,284"; F1's
  `.card:has(> .stat)` look is unchanged (the label's `order: -1` is harmless).
- **Relative time.** The kit's `relTime` is the prototype's wording ("5 min ago"); the bell
  (F8) keeps its own `agoLabel` ("5 minutes ago", Intl's relative format). Two wordings for
  the same thing is an owner question (below), not something this slice converts.
- **A `pending` status** (a change waiting in a release) maps to the klein badge, for R-lane
  screens.
- **The contrast gate** asserts four new pairs: ink and dim on a chosen row
  (`primary-soft`), "Unsaved changes" (`warn-text` on card, as text) and the ring's ok arc.
- **A chip's count is its own word** in the chip's name ("Draft 12", not "Draft12"): a space
  the flex gap draws nothing for.

## The bundle (Admin v2 P-10)

`admin-ui` claimed every module under `src/{components,lib}/admin/` by path, so the whole kit
and the reference screen would have ridden along on every admin screen (each screen's eager
graph went to 117.5 KB gz in the first build). `astro.config.mjs` now leaves the kit
(`ADMIN_KIT`: `components/admin/kit/`, `lib/admin/client/`) and the reference screen
(`ADMIN_KIT_SCREEN`: the `AdminKit` island and `screens/kit/`) out of the group's test. A
group takes its modules' static dependencies, so a kit piece lands in `admin-ui` as soon as
a screen there imports it. What of the kit no screen there imports goes to the lowest admin
group, `admin-kit` (only `/admin/kit` loads it today), and the reference screen's own code
stays in its `AdminKit` entry chunk.

A group never follows `import()`. Before `admin-kit` existed, a kit module reached only
lazily (an enhancer AdminLayout's script loads from `lib/admin/client/`, ui.md §2.1) would
have become a chunk named after itself, weighed against the public budget and failed by
`scripts/admin-bundle.mjs` as a public chunk importing admin code. `tests/lib/adminBundle.spec.ts`
now checks that every module under `src/{components,lib}/admin/` is claimed by an `admin-*`
group (island entries and the reference screen's code aside), and that the script accepts a
lazily loaded `admin-kit` chunk.

Measured with `npm run size` (gzip):

| | main (`4a6d78c`) | F4b |
|---|---|---|
| Each admin screen's eager graph | 107.6 to 107.7 KB | 111.1 to 111.2 KB |
| `/admin/kit` (`AdminKit`) | (none) | 119.6 KB |
| Sign-in script | 2.2 KB | 2.2 KB |
| `admin-rich` (lazy) | 122.2 KB | 122.2 KB |
| size-limit admin sum (≤ 300 KB) | 228.56 KB | 240.56 KB |
| size-limit public (≤ 100 KB) | 25.51 KB | 25.51 KB |

The 3.5 KB every screen gains is what ResourceTable now draws with: DataTable (its paging,
step back, page-scoped selection and row language), Pager, Chips, the status badge, the
paging model and the Riyadh clock.

## Owner questions

- **One wording for relative time.** The bell says "5 minutes ago" (F8, Intl), the kit "5 min
  ago" (the prototype). Pick one; the other slice's screens follow when they are next touched.
- **`/admin/kit` in production.** It is harmless (made-up data, its content reads nothing, every role) and is
  what the sweep and the kit's e2e check; it could be limited to non-production deployments
  if the studio would rather staff never see it.
