# C4c: the Pipeline board

- **Lane:** CRM (Wave 3, after C4b)
- **Design:** [crm.md](../crm.md) CRM-4, §11 "UI contract" item 2; the Wave 3 brief's §7.2 and
  §13 ("If C4b's diff passes about 3,500 lines, carve out C4c: the board").
- **PR:** the `feat/c4c-leads-board` branch, stacked on `feat/c4b-leads-screens` (C4b merges
  first; this branch then merges `main`).
- **Migration:** `0068_help_leads_board.sql` **for now: the number is decided at merge time.**
  The help set only, restated from C4b's 0065 (the latest restatement this branch can know of,
  rebuilt with `hs_rebase.py`) with one line added to `working-with-leads`. It first took 0079,
  the wave's first slack number, but a 0079 on `main` would block R5 (0066) and G2 (0067), which
  merge before C4c; so it sits at 0068 until then and, at its merge, takes the lowest free number
  above `main`'s highest (0068 if U7a has not merged, else the next; `renumber-migration.mjs`
  only moves a file up). Before its push it is re-based again, onto G2's 0067 (`hs_rebase.py`
  0065 → 0067), or onto whatever restatement is newest on `main` then (corrections rule 1:
  the migration's "as 00NN left it" comments, its guide-count postcondition, `help_centre.test.sql`,
  `helpCentre.spec`'s previous-file constant and per-role lists, this note and the read-back).
  The ledger's Reserved table carries the row as "0068 (for now)"; 0079 to 0081 stay slack.

## Why it is its own slice

C4b came to about 6,000 lines without its migration's copied guides, past the brief's ~3,500.
The brief names the board as the piece to carve out, with its tab and its help line, so the help
set is restated twice (0065 without the board, 0068 for now with it). The board's code was written and
tested inside C4b, carved out of it (C4b's commit "carve the pipeline board out of C4b into C4c"),
and restored here in one commit; this branch adds about 800 lines to C4b.

## What was built

- **`/admin/leads/board`** (`src/pages/admin/leads/board.astro`, the `AdminLeadsBoard` island,
  `screens/leads/LeadsBoard.tsx`), titled "Pipeline", its first view rendered on the server
  (`readBoardInitial` in `src/lib/crm/leadPage.ts`: the frame's four reads, the board and its
  labels, 7 round trips on top of the shell) for the address's filters (whose, where from, which
  discipline, since when; never a search). A role without `leads.manage` gets a 403 and
  `Refused.astro`, having read nothing.
- **Columns:** one per stage in board order, non-spam leads only; a coloured dot (decorative),
  the stage as an h2, the count with "leads" for a screen reader, and for won the value in SAR;
  at most 50 cards, then "Show all {n} in the list" (the list filtered to that stage, the
  board's other filters kept). An empty column says "No leads here".
- **Cards:** an `<article>` with the name as the link to the lead's page, the company, the
  interest, the value if set, the age, the assignee's avatar (named), a star and an unread dot
  with their words for a screen reader, and **"Move to…"** (`MoveTo.tsx`, shared with a lead's
  page): a disclosure button named "Move to… {name}" that shows the other stages as buttons
  (arrow keys, Home and End step through them, Escape closes and returns focus, a press outside
  closes). Choosing one sends the versioned PATCH; the card moves to the top of its new column,
  the counts and the won sum follow, the island's status region says "Moved {name} to {stage}."
  and focus goes to the card's link. A 409 re-reads the board and says "Someone else changed
  {name}. Refreshed."
- **The region:** `<div class="kb" role="region" aria-label="Pipeline" tabindex="0">`, so five
  230 px columns scroll sideways inside it at a phone's width and never the page (WCAG 1.4.10;
  axe's `scrollable-region-focusable`).
- **The toolbar:** the same search (posted, never in the address) and filters as the list, with
  no sort (each column is newest first) and no chips (the board shows every stage).
- **The menu:** the Leads area's tabs List | Pipeline (`src/lib/admin/nav/crm.ts`, decision D2);
  a lead's page lights List. The board is in `LOCKED_SCREENS`, `render: 'server'`, with
  `GET /api/admin/crm/stages` as its API twin (its own data route is a POST).
- **CSS:** `.kb`, `.kb__col`, `.kb__h`, `.kb__t`, `.kb__dot[data-tone]`, `.kb__sum`, `.kb__cnt`,
  `.kb__b`, `.kb__empty`, `.kb__more`, `.kcard` and its parts in `public/styles/admin/leads.css`,
  ported from the prototype's `.kb`/`.kcard` onto tokens.
- **Help (0068 for now):** "On the Pipeline tab each stage is a column. Use Move to… on a card to change
  its stage. The Won column adds up its value in SAR." (and its Arabic) added to the guide's
  first list; nothing else in the set moves.

## Bundle

| (gzip, KB = 1,000 B) | C4b (as built) | C4c, after merging C4b at c76c2da |
|---|---|---|
| size-limit admin sum (tripwire 400) | 310.66 | 312.25 |
| each leads screen, eager | 134.7 | 136.2 (`AdminLeadsList`, `AdminLeadsBoard`, `AdminLeadDetail`) |

The board joins the `admin-leads` group by its path; check 6 of `scripts/admin-bundle.mjs`
already allows any `AdminLead*` entry.

## Brought up to C4b's pre-merge review fixes

C4c was carved out of an earlier C4b head; C4b's review fixes (to `c76c2da`) were merged in, and
those that touch the board were applied to it too:

- **Focus after "Move to…"** (C4b: the button takes focus back once a move settles, never from
  where the person went meanwhile). The board shares `MoveTo.tsx`, so a refused move gives focus
  back to the card's button; on a move the moved card's link takes focus only when focus was
  lost with its old place (`cardTakesFocus`), and a conflict's refresh that puts the card in
  another column now follows it too (before, its button left with it and focus dropped to the
  body).
- **The toolbar-only filter rule** (C4b: an address carries only what the toolbar can show). The
  board has no chips, sort or pages, so `boardFilters()` (`leadUrl.ts`) drops a pasted list's
  `stage`, `sort` and `page` on the server and in the island: they stayed in the board's address
  and every card's link, and a lead's Previous/Next then walked a filter the board never showed.
- **Waiting for hydration in e2e:** the board's tests open it through `visit()`, as
  `leadsE2e.spec` requires (it failed on the board's two bare `goto()`s).
- **Toasts said on the landing page** and **the sweep's oldest-lead sample** come with the merge:
  the board's "Add lead manually" is C4b's drawer (`?done=lead-added` on the lead's page), and
  the board has no edit sample or toast of its own.

## Departures from the design, and why

1. **No pointer drag** (decision D5, crm.md: optional). "Move to…" is on every card. Drag would
   need the kit's Sortable core in cross-list mode, CSSOM-only movement and a pass of the sweep;
   left for a later slice. The sub-line says "Use Move to… on a card to change its stage. Won
   cards add up at the top of their column." rather than "Drag a card…".
2. **List | Pipeline tabs**, not the prototype's Inbox | Pipeline segmented switch (decision D2):
   "Inbox" is L6's messaging, and tabs are links the sweep reaches with no script.
3. **"Move to… {name}"**, the visible words first (WCAG 2.5.3), as on a lead's page.
4. **A separate slice and a second restatement** (above).

## Tests

- Vitest: `leadsScreens.spec` (the region, its label and tab stop, "Move to…" naming each card and
  closed until pressed, the won sum, the counts, "Show all", no style, no PII, the cards'
  links free of a chip, sort or page, the focus rule), `leadUrl.spec` (`boardFilters`), `leadPage.spec`
  (the board's read: 50 a column, no chip, sort or page), `adminBundle.spec` (the board's island
  and screen claimed by `admin-leads`, a fixture with all three islands), `adminRoutes.spec`
  (the board as a server-rendered locked screen), `adminStyles.spec` (leads.css on the three
  pages), `helpCentre.spec` (0068 against 0065: one line in each language; the guide's claims
  include "Pipeline").
- pgTAP `supabase/tests/help_leads_board.test.sql`, `plan(4)`; `help_leads_v2.test.sql`, run
  against the latest set, still holds. Replayed on the PGlite harness: 4 of 4 and 10 of 10.
- The read-back (`readback_0068.sql` in the program's scratchpad, renamed with the file): on the harness it matches but
  for the server version and the guide's version (1 there, 3 in production).
- E2E (CI only): `tests/admin/leads.e2e.ts` adds the board by keyboard (Move to…, an arrow, Enter,
  the status words, focus on the card in its new column, Escape returning focus, axe with the
  menu open) and the board at 320 and 390 px (the region scrolls, the page does not, axe), and
  the refusals cover `/admin/leads/board`; `refusals.e2e.ts` and the per-role sweep pick the
  board up from `LOCKED_SCREENS` and the menu.
