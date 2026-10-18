# C4c: the Pipeline board

- **Lane:** CRM (Wave 3, after C4b)
- **Design:** [crm.md](../crm.md) CRM-4, §11 "UI contract" item 2; the Wave 3 brief's §7.2 and
  §13 ("If C4b's diff passes about 3,500 lines, carve out C4c: the board").
- **PR:** the `feat/c4c-leads-board` branch, stacked on `feat/c4b-leads-screens` (C4b merges
  first; this branch then merges `main`).
- **Migration:** `0068_help_leads_board.sql`. The help set only, restated from C4b's 0065 (the
  latest restatement this branch can know of, rebuilt with `hs_rebase.py`) with one line added to
  `working-with-leads`. It first took 0079, the wave's first slack number, but a 0079 on `main`
  would block R5 (0066) and G2 (0067), which merge before C4c. C4c therefore merges after G2 and
  takes **0068**, and every later Wave 3 reservation moves up by one (2026-10-18): U7a 0069,
  U10a 0070, G1a 0071, U17 0072, U10b 0073, U8a 0074, U9a 0075, G1b 0076, U11 0077, U9b 0078,
  G1c 0079; the slack is 0080 to 0082 and the next free number 0083 (the ledger's Reserved
  table). U7a cannot keep 0068 by merging first instead: C4c could then only move up to 0069,
  and the numbers above it are held.
- **The re-base onto G2, at merge time.** G2's 0067 rewrites `site-health-and-logs` and merges
  first; 0068 is not yet re-based on it (G2 had not merged when C4c was finished). Until it is,
  0068 cannot revert G2's guide: it keeps the set it finds (`_help_set_before_0068`, a temporary
  table dropped at commit) and its postconditions refuse any guide but `working-with-leads` that
  differs from it, so an un-re-based push (or CI's replay once G2 is merged in) fails with
  "0068: the set changes guides it does not own (site-health-and-logs)". Replayed on the PGlite
  harness with G2's 0067 (re-based onto 0065) before it: refused; with 0068 re-based on that
  0067: applied, `help_leads_board.test.sql` 4 of 4, `help_leads_v2.test.sql` 10 of 10, and
  the read-back matches but for the server version and the guide's version. After merging
  `main` with G2 in it, the re-base updates exactly:
  1. the set: `python -I hs_rebase.py 0065_help_leads_v2.sql 0067_health_probes.sql
     0068_help_leads_board.sql --write` (OLD 0065, NEW 0067, from `main`). The dry run must
     print "slice adds [] removes [] changes ['working-with-leads']" and "new base changed
     ['site-health-and-logs']" (anything more means G2 was not re-based onto 0065 itself:
     stop), and "15 guides in new base -> 15";
  2. 0068's comments: "Depends on … 0065" and "The set as 0065 (C4b) left it … every other
     guide is 0065's" become 0067 (G2), and the header's "Before its push the set is re-based
     on G2's 0067 …" sentence is reduced to the guard's reason; "Production as of" names 0067
     as pushed before it. The guard and the 15-guide postconditions stay as they are;
  3. `tests/lib/helpCentre.spec.ts`: the base in "C4c (0068) restates C4b's set (0065)" and in
     the guard's test (`setOf('0065_help_leads_v2.sql')`, twice) becomes
     `0067_health_probes.sql`, the first test's title naming G2's set (0067); G2's own spec
     test (its set against 0065) is left as G2 wrote it;
  4. `supabase/tests/help_leads_board.test.sql`: its third assertion's message says 0067's
     (the values do not change: G2 leaves `working-with-leads` alone);
  5. the read-back (`readback_0068.sql` in the program's scratchpad): already expects 0067 in
     the ledger and holds the canary `tenants_with_g2_health_guide = 1` (every tenant's
     `site-health-and-logs` equals the set's and still says "The Uptime card"); re-check that
     phrase against G2's merged guide, and nothing else changes;
  6. this note: this bullet becomes one line saying the set is re-based on 0067.

## Why it is its own slice

C4b came to about 6,000 lines without its migration's copied guides, past the brief's ~3,500.
The brief names the board as the piece to carve out, with its tab and its help line, so the help
set is restated twice (0065 without the board, 0068 with it). The board's code was written and
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
- **Help (0068):** "On the Pipeline tab each stage is a column. Use Move to… on a card to change
  its stage. The Won column adds up its value in SAR." (and its Arabic) added to the guide's
  first list; nothing else in the set moves.

## Bundle

| (gzip, KB = 1,000 B) | C4b (as built) | C4c, after merging C4b at c76c2da | C4c at its pre-merge fixes, `main` merged (U4 #82, R8 #81) |
|---|---|---|---|
| size-limit admin sum (tripwire 400) | 310.66 | 312.25 | **312.34** (the figure CLAUDE.md's F4 amendment states) |
| each leads screen, eager (limit 300) | 134.7 | 136.2 | 136.3 (`AdminLeadsList`, `AdminLeadsBoard`, `AdminLeadDetail`) |

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

## C4c's pre-merge review fixes

The correctness review confirmed five low findings:

1. **The ledger row** now says C4c merges after G2 and takes 0068, and the Reserved table moves
   every later Wave 3 reservation up by one (the Migration bullet above).
2. **The help set before G2's re-base:** 0068's guard refuses to revert a guide it does not own,
   and the read-back's `tenants_with_g2_health_guide` canary checks G2's guide survives; the
   re-base itself waits for G2's merge (the steps above).
3. **Focus after a conflict's refresh that drops the card** (a colleague marked it spam, which
   the board leaves out, or it now falls outside the filters): its "Move to…" left with it and
   focus fell to the body (WCAG 2.4.3). `focusTargetAfterMove` gives focus to the card's link,
   else the heading of the column it left (`tabIndex=-1`), else the board's region.
4. **A read already in flight when a move lands** (a filter or search started before the PATCH)
   would redraw the card in its old column with its old version, and the next move would be a
   needless 409. The board keeps the read in flight and, after a move, reads again (the re-run
   aborts the stale read); the e2e waits for its search's answer before it opens "Move to…".
5. **The bundle figure** in CLAUDE.md is the measured one (Bundle, above).

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
